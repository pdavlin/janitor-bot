/**
 * Orchestrator for a single `:repeat:` reaction on a play reply.
 *
 * Flow:
 *   1. Feature-flag check — full short-circuit when disabled.
 *   2. Read the play row.
 *   3. Dedupe against the latest event for (game_pk, play_index): when the
 *      prior attempt's `prior_video_url` matches the current `plays.video_url`
 *      and that attempt was not itself a `deduped` row, record a `deduped`
 *      event and stop.
 *   4. Refetch the game's video candidate list from the MLB content API.
 *   5. Call the phase-1 `rematchVideo` agent.
 *   6. Apply the outcome: update plays + edit the Slack message on `swapped`,
 *      post a thread reply, always insert an audit row.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../logger";
import {
  rematchVideo as defaultRematchVideo,
  type RematchCandidate,
  type RematchResult,
} from "../detection/rematch-agent";
import { selectPlaybackUrl } from "../detection/video-match";
import { fetchGameContent } from "../api/mlb-client";
import type { HighlightItem } from "../types/mlb-api";
import {
  editPlayMessage,
  postThreadTextWithTs,
  uploadFile,
  type SlackClientConfig,
} from "./slack-client";
import { buildPlayReplyMessage } from "./slack-formatter";
import type { StoredPlay } from "../types/play";
import {
  getLatestRematchEvent,
  insertPlayRematchEvent,
  insertAngleEvent,
  hasAngleTriggerRun,
  type PlayRematchEvent,
} from "./play-rematch-events-store";
import { resolveAlternateAngle } from "../detection/filmroom-angles";

export interface RematchPlayArgs {
  db: Database;
  slackConfig: SlackClientConfig;
  logger: Logger;
  channel: string;
  ts: string;
  gamePk: number;
  playIndex: number;
  userId: string;
  eventTs: string;
  /** Feature flag. When false, the handler returns immediately. */
  enabled: boolean;
  /** Anthropic API key. When missing, the handler logs and exits. */
  apiKey: string | undefined;
  /** Anthropic model identifier. */
  model: string;
}

/**
 * Injection seam for tests. Real callers pass nothing and get the live
 * agent + MLB fetcher.
 */
export interface RematchPlayDeps {
  rematchVideo?: typeof defaultRematchVideo;
  fetchGameVideos?: (
    gamePk: number,
    logger: Logger,
  ) => Promise<HighlightItem[]>;
}

export interface AngleTriggerArgs {
  db: Database;
  slackConfig: SlackClientConfig;
  logger: Logger;
  channel: string;
  ts: string;
  gamePk: number;
  playIndex: number;
  userId: string;
  eventTs: string;
  /** Feature flag. When false, the handler returns immediately. */
  enabled: boolean;
  /** Maximum age of the play's post in hours for angle eligibility. */
  windowHours: number;
}

export interface AngleTriggerDeps {
  resolveAngle?: typeof resolveAlternateAngle;
}

/** Minimal play shape the orchestrator needs. */
interface PlayForRematch {
  description: string;
  fielderId: number;
  videoUrl: string | null;
  videoTitle: string | null;
}

export async function rematchPlay(
  args: RematchPlayArgs,
  deps: RematchPlayDeps = {},
): Promise<void> {
  if (!args.enabled) {
    args.logger.debug("rematch handler disabled by feature flag", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
    });
    return;
  }

  const play = readPlay(args.db, args.gamePk, args.playIndex);
  if (!play) {
    args.logger.warn("rematch: play row not found", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
    });
    return;
  }

  const latest = getLatestRematchEvent(args.db, args.gamePk, args.playIndex);
  if (
    latest &&
    sameVideo(latest.priorVideoUrl, play.videoUrl) &&
    latest.decision !== "deduped"
  ) {
    insertPlayRematchEvent(args.db, {
      ...baseEvent(args),
      priorVideoUrl: play.videoUrl,
      newVideoUrl: null,
      decision: "deduped",
      agentReason: null,
    });
    args.logger.info("rematch deduped", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
      userId: args.userId,
    });
    return;
  }

  if (!args.apiKey) {
    args.logger.error("rematch: anthropic api key missing", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
    });
    return;
  }

  const fetchVideos = deps.fetchGameVideos ?? defaultFetchGameVideos;
  let candidates: HighlightItem[];
  try {
    candidates = await fetchVideos(args.gamePk, args.logger);
  } catch (err) {
    args.logger.error("rematch: fetchGameVideos failed", {
      gamePk: args.gamePk,
      error: err instanceof Error ? err.message : String(err),
    });
    await postThreadTextWithTs(
      args.slackConfig,
      args.channel,
      args.ts,
      `Re-match request failed — see logs.`,
      args.logger,
    );
    return;
  }

  const usable = candidates.filter((c): c is HighlightItem & { id: string } =>
    typeof c.id === "string" && c.id.length > 0,
  );

  if (usable.length === 0) {
    insertPlayRematchEvent(args.db, {
      ...baseEvent(args),
      priorVideoUrl: play.videoUrl,
      newVideoUrl: null,
      decision: "no_match",
      agentReason: "no candidates available from MLB API",
    });
    await postThreadTextWithTs(
      args.slackConfig,
      args.channel,
      args.ts,
      `Agent could not identify a better video at <@${args.userId}>'s request.`,
      args.logger,
    );
    return;
  }

  const currentVideoId = findCandidateIdForUrl(play.videoUrl, usable);
  const rematchVideoFn = deps.rematchVideo ?? defaultRematchVideo;

  let result: RematchResult;
  try {
    result = await rematchVideoFn(
      args.apiKey,
      args.model,
      {
        playDescription: play.description,
        currentVideoId,
        candidates: usable.map(toRematchCandidate),
        gamePk: args.gamePk,
      },
      args.logger,
    );
  } catch (err) {
    args.logger.error("rematch agent threw", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
      error: err instanceof Error ? err.message : String(err),
    });
    await postThreadTextWithTs(
      args.slackConfig,
      args.channel,
      args.ts,
      `Re-match request failed — see logs.`,
      args.logger,
    );
    return;
  }

  await applyOutcome(args, play, result, usable);
}

/**
 * Orchestrator for a single `:movie_camera:` reaction on a play reply.
 *
 * Flow:
 *   1. Feature-flag check — full short-circuit when disabled.
 *   2. Window check — ignore if the play's post is older than the configured window.
 *   3. Dedup — if a angle-trigger already ran for this play, record and stop.
 *   4. Record the attempt.
 *   5. Resolve alternate angle from Film Room CDN.
 *   6. On `found`, upload the angle to the thread; on `no_alternate`/`error`, post nothing.
 */
export async function handleAngleTrigger(
  args: AngleTriggerArgs,
  deps: AngleTriggerDeps = {},
): Promise<void> {
  if (!args.enabled) {
    args.logger.debug("angle trigger disabled by feature flag", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
    });
    return;
  }

  // Window check: ignore plays older than the configured window.
  const play = readPlayForAngle(args.db, args.gamePk, args.playIndex);
  if (!play) {
    args.logger.warn("angle: play row not found", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
    });
    return;
  }

  // Slack event_ts is epoch SECONDS as a string ("1779832888.133879");
  // new Date(string) on that yields Invalid Date, so parse it numerically.
  // SQLite datetime('now') is UTC with a space separator — force UTC parse.
  const eventEpoch = parseFloat(args.eventTs);
  const nowMs = Number.isFinite(eventEpoch) ? eventEpoch * 1000 : Date.now();
  const createdMs = new Date(`${play.createdAt.replace(" ", "T")}Z`).getTime();
  const ageHours = (nowMs - createdMs) / (1000 * 60 * 60);
  if (Number.isFinite(ageHours) && ageHours > args.windowHours) {
    args.logger.debug("angle: play outside window", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
      ageHours: Math.round(ageHours),
      windowHours: args.windowHours,
    });
    return;
  }

  // Dedup: if a angle-trigger already ran for this play, record and stop.
  if (hasAngleTriggerRun(args.db, args.gamePk, args.playIndex)) {
    insertAngleEvent(args.db, {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
      userId: args.userId,
      decision: "angle_deduped",
      agentReason: "angle trigger already attempted for this play",
      eventTs: args.eventTs,
    });
    args.logger.info("angle deduped", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
      userId: args.userId,
    });
    return;
  }

  if (!play.playId) {
    insertAngleEvent(args.db, {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
      userId: args.userId,
      decision: "angle_no_alternate",
      agentReason: "no play_id available for angle lookup",
      eventTs: args.eventTs,
    });
    args.logger.debug("angle: no play_id on play", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
    });
    return;
  }

  // Resolve alternate angle.
  const resolveAngle = deps.resolveAngle ?? resolveAlternateAngle;
  const result = await resolveAngle(args.gamePk, play.playId, args.logger);

  if (result.status === "found") {
    // Upload the angle to the thread.
    const angleLabel =
      result.feedType === "cf" ? "Center field angle" : "High home angle";
    const filename = `${result.feedType}-angle.mp4`;

    const uploadResult = await uploadFile(
      args.slackConfig,
      args.channel,
      args.ts,
      result.bytes,
      filename,
      angleLabel,
      args.logger,
    );

    insertAngleEvent(args.db, {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
      userId: args.userId,
      decision: "angle_found",
      agentReason: uploadResult
        ? `${result.feedType} angle uploaded` : `${result.feedType} angle resolved but upload failed`,
      eventTs: args.eventTs,
    });

    args.logger.info("angle trigger completed", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
      userId: args.userId,
      feedType: result.feedType,
      uploadOk: uploadResult !== null,
    });
    return;
  }

  // no_alternate or error — record outcome and post nothing.
  const decision = result.status === "no_alternate" ? "angle_no_alternate" : "angle_error";
  const reason = result.status === "error" ? result.error : "no alternate angle available";

  insertAngleEvent(args.db, {
    gamePk: args.gamePk,
    playIndex: args.playIndex,
    userId: args.userId,
    decision,
    agentReason: reason,
    eventTs: args.eventTs,
  });

  args.logger.info("angle trigger no angle", {
    gamePk: args.gamePk,
    playIndex: args.playIndex,
    userId: args.userId,
    decision,
  });
}

async function applyOutcome(
  args: RematchPlayArgs,
  play: PlayForRematch,
  result: RematchResult,
  candidates: Array<HighlightItem & { id: string }>,
): Promise<void> {
  if (result.decision === "swapped") {
    const chosen = candidates.find((c) => c.id === result.videoId);
    if (!chosen) {
      args.logger.warn("rematch: agent returned unknown video id", {
        gamePk: args.gamePk,
        playIndex: args.playIndex,
        videoId: result.videoId,
      });
      insertPlayRematchEvent(args.db, {
        ...baseEvent(args),
        priorVideoUrl: play.videoUrl,
        newVideoUrl: null,
        decision: "no_match",
        agentReason: result.reason ?? "agent returned unknown video id",
      });
      await postThreadTextWithTs(
        args.slackConfig,
        args.channel,
        args.ts,
        `Agent could not identify a better video at <@${args.userId}>'s request.`,
        args.logger,
      );
      return;
    }
    const newUrl = selectPlaybackUrl(chosen.playbacks);
    if (!newUrl) {
      args.logger.warn("rematch: chosen candidate has no playback url", {
        gamePk: args.gamePk,
        playIndex: args.playIndex,
        videoId: result.videoId,
      });
      insertPlayRematchEvent(args.db, {
        ...baseEvent(args),
        priorVideoUrl: play.videoUrl,
        newVideoUrl: null,
        decision: "no_match",
        agentReason: result.reason ?? "chosen candidate has no playback url",
      });
      await postThreadTextWithTs(
        args.slackConfig,
        args.channel,
        args.ts,
        `Agent could not identify a better video at <@${args.userId}>'s request.`,
        args.logger,
      );
      return;
    }

    const newTitle = chosen.title;
    const priorUrl = play.videoUrl;

    const tx = args.db.transaction(() => {
      args.db
        .prepare(
          `UPDATE plays SET video_url = $url, video_title = $title
           WHERE game_pk = $gamePk AND play_index = $playIndex;`,
        )
        .run({
          $url: newUrl,
          $title: newTitle,
          $gamePk: args.gamePk,
          $playIndex: args.playIndex,
        });
      insertPlayRematchEvent(args.db, {
        ...baseEvent(args),
        priorVideoUrl: priorUrl,
        newVideoUrl: newUrl,
        decision: "swapped",
        agentReason: result.reason ?? null,
      });
    });
    tx();

    const updated = readPlayFull(args.db, args.gamePk, args.playIndex);
    let editOk = false;
    if (updated) {
      const payload = buildPlayReplyMessage(updated);
      editOk = await editPlayMessage(
        args.slackConfig,
        args.channel,
        args.ts,
        payload,
        args.logger,
      );
    }

    const note = editOk
      ? `Re-matched video at <@${args.userId}>'s request.`
      : `Re-matched video at <@${args.userId}>'s request (message edit failed — see logs).`;
    await postThreadTextWithTs(
      args.slackConfig,
      args.channel,
      args.ts,
      note,
      args.logger,
    );
    args.logger.info("rematch swapped", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
      userId: args.userId,
      priorVideoUrl: priorUrl,
      newVideoUrl: newUrl,
      editOk,
    });
    return;
  }

  if (result.decision === "agreed") {
    insertPlayRematchEvent(args.db, {
      ...baseEvent(args),
      priorVideoUrl: play.videoUrl,
      newVideoUrl: play.videoUrl,
      decision: "agreed",
      agentReason: result.reason ?? null,
    });
    await postThreadTextWithTs(
      args.slackConfig,
      args.channel,
      args.ts,
      `Agent reviewed at <@${args.userId}>'s request and agreed with the current video.`,
      args.logger,
    );
    args.logger.info("rematch agreed", {
      gamePk: args.gamePk,
      playIndex: args.playIndex,
      userId: args.userId,
    });
    return;
  }

  // no_match
  insertPlayRematchEvent(args.db, {
    ...baseEvent(args),
    priorVideoUrl: play.videoUrl,
    newVideoUrl: null,
    decision: "no_match",
    agentReason: result.reason ?? null,
  });
  await postThreadTextWithTs(
    args.slackConfig,
    args.channel,
    args.ts,
    `Agent could not identify a better video at <@${args.userId}>'s request.`,
    args.logger,
  );
  args.logger.info("rematch no_match", {
    gamePk: args.gamePk,
    playIndex: args.playIndex,
    userId: args.userId,
  });
}

function baseEvent(args: RematchPlayArgs): Omit<
  PlayRematchEvent,
  "priorVideoUrl" | "newVideoUrl" | "decision" | "agentReason"
> {
  return {
    gamePk: args.gamePk,
    playIndex: args.playIndex,
    userId: args.userId,
    eventTs: args.eventTs,
  };
}

/**
 * Null-safe equality for video URLs. Two null values count as the same
 * baseline (no-video state) so dedupe fires correctly when a play has
 * never had a video.
 */
function sameVideo(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  return a === b;
}

function readPlay(
  db: Database,
  gamePk: number,
  playIndex: number,
): PlayForRematch | null {
  const row = db
    .prepare(`
      SELECT description, fielder_id, video_url, video_title
      FROM plays
      WHERE game_pk = $gamePk AND play_index = $playIndex
      LIMIT 1;
    `)
    .get({ $gamePk: gamePk, $playIndex: playIndex }) as
    | {
        description: string;
        fielder_id: number;
        video_url: string | null;
        video_title: string | null;
      }
    | null;
  if (!row) return null;
  return {
    description: row.description,
    fielderId: row.fielder_id,
    videoUrl: row.video_url,
    videoTitle: row.video_title,
  };
}

/** Minimal play shape the angle handler needs. */
interface PlayForAngle {
  playId: string | null;
  createdAt: string;
}

function readPlayForAngle(
  db: Database,
  gamePk: number,
  playIndex: number,
): PlayForAngle | null {
  const row = db
    .prepare(`
      SELECT play_id, created_at
      FROM plays
      WHERE game_pk = $gamePk AND play_index = $playIndex
      LIMIT 1;
    `)
    .get({ $gamePk: gamePk, $playIndex: playIndex }) as
    | { play_id: string | null; created_at: string }
    | null;
  if (!row) return null;
  return {
    playId: row.play_id,
    createdAt: row.created_at,
  };
}

function readPlayFull(
  db: Database,
  gamePk: number,
  playIndex: number,
): StoredPlay | null {
  const row = db
    .prepare(`SELECT * FROM plays WHERE game_pk = $gamePk AND play_index = $playIndex LIMIT 1;`)
    .get({ $gamePk: gamePk, $playIndex: playIndex }) as
    | Record<string, unknown>
    | null;
  if (!row) return null;
  return {
    id: row.id as number,
    gamePk: row.game_pk as number,
    playIndex: row.play_index as number,
    date: row.date as string,
    fielderId: row.fielder_id as number,
    fielderName: row.fielder_name as string,
    fielderPosition: row.fielder_position as string,
    runnerId: row.runner_id as number,
    runnerName: row.runner_name as string,
    targetBase: row.target_base as string,
    batterName: row.batter_name as string,
    inning: row.inning as number,
    halfInning: row.half_inning as string,
    awayScore: row.away_score as number,
    homeScore: row.home_score as number,
    awayTeam: row.away_team as string,
    homeTeam: row.home_team as string,
    description: row.description as string,
    creditChain: row.credit_chain as string,
    tier: row.tier as StoredPlay["tier"],
    outs: row.outs as number,
    runnersOn: row.runners_on as string,
    isOverturned: (row.is_overturned as number) === 1,
    videoUrl: (row.video_url as string | null) ?? null,
    videoTitle: (row.video_title as string | null) ?? null,
    playId: (row.play_id as string | null) ?? null,
    fetchStatus: (row.fetch_status as StoredPlay["fetchStatus"]) ?? null,
    throwVelocity: (row.throw_velocity as number | null) ?? null,
    throwVelocityStatus: (row.throw_velocity_status as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

async function defaultFetchGameVideos(
  gamePk: number,
  _logger: Logger,
): Promise<HighlightItem[]> {
  const content = await fetchGameContent(gamePk);
  return content?.highlights?.highlights?.items ?? [];
}

function findCandidateIdForUrl(
  videoUrl: string | null,
  candidates: Array<HighlightItem & { id: string }>,
): string | null {
  if (!videoUrl) return null;
  for (const c of candidates) {
    if (selectPlaybackUrl(c.playbacks) === videoUrl) return c.id;
  }
  return null;
}

function toRematchCandidate(item: HighlightItem & { id: string }): RematchCandidate {
  return {
    id: item.id,
    description: item.description,
    title: item.title,
  };
}
