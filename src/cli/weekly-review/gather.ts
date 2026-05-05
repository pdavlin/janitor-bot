/**
 * Data gather for the weekly-review run.
 *
 * Three logical steps, sequentially:
 *   1. SQL gather of plays + snapshots + tags + slack header refs from
 *      the local DB, scoped to the target week.
 *   2. Resolve the bot's `user_id` once (cached) so transcript fetches
 *      can drop the bot's own messages.
 *   3. For each game with a recorded header `ts`, hit Slack's
 *      `conversations.replies`, filter out bot messages and digest
 *      ts/parent_ts hits, then enforce a per-game 2k-token cap.
 *
 * The returned `Transcript` is the only object that carries user prose
 * and is held in memory only (typed boundary + CI grep enforce that).
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../../logger";
import type { Tier, FetchStatus } from "../../types/play";
import type { PlayTagRow } from "../../notifications/play-tags-store";
import type { TagType } from "../../notifications/comment-tags";
import {
  callSlackApi,
  type SlackClientConfig,
} from "../../notifications/slack-client";

export type { PlayTagRow };
import { queryPriorFindings } from "./findings-store";
import {
  buildTranscript,
  type Transcript,
  type TranscriptGame,
  type TranscriptMessage,
  type FindingRow,
} from "./types";
import type { WeekWindow } from "./week-window";

/** Subset of `plays` columns the prompt cares about. */
export interface GatheredPlay {
  id: number;
  gamePk: number;
  playIndex: number;
  date: string;
  fielderPosition: string;
  targetBase: string;
  tier: Tier;
  outs: number;
  runnersOn: string;
  inning: number;
  halfInning: string;
  awayTeam: string;
  homeTeam: string;
  creditChain: string;
  fetchStatus: FetchStatus | null;
}

export interface VoteSnapshotRow {
  gamePk: number;
  playIndex: number;
  fireCount: number;
  trashCount: number;
  netScore: number;
  voterCount: number;
  tierReviewFlagged: boolean;
}

export interface GatheredData {
  window: WeekWindow;
  plays: GatheredPlay[];
  snapshots: VoteSnapshotRow[];
  tags: PlayTagRow[];
  transcript: Transcript;
  channelCorrections: TranscriptMessage[];
  priorFindings: FindingRow[];
  botUserId: string | null;
}

interface GameHeaderRef {
  gamePk: number;
  channel: string;
  ts: string;
}

const PER_GAME_TOKEN_CAP = 2000;
const CHARS_PER_TOKEN = 4; // Rough heuristic; precision irrelevant for ~200k context.

/**
 * Fetches the bot's own `user_id` via `auth.test`. Returns null on any
 * failure; callers degrade by skipping the bot-message filter.
 */
async function resolveBotUserId(
  config: SlackClientConfig,
  logger: Logger,
): Promise<string | null> {
  if (!config.botToken) return null;
  const result = await callSlackApi<{ user_id: string }>(
    "auth.test",
    {},
    config.botToken,
    logger,
  );
  return result?.user_id ?? null;
}

function queryPlaysInWindow(db: Database, window: WeekWindow): GatheredPlay[] {
  const rows = db
    .prepare(
      `
      SELECT MIN(id) AS id, game_pk, play_index, date, fielder_position,
             target_base, tier, outs, runners_on, inning, half_inning,
             away_team, home_team, credit_chain, fetch_status
      FROM plays
      WHERE date BETWEEN $from AND $to
      GROUP BY game_pk, play_index
      ORDER BY date ASC, game_pk ASC, play_index ASC;
    `,
    )
    .all({ $from: window.weekStarting, $to: window.weekEnding }) as {
    id: number;
    game_pk: number;
    play_index: number;
    date: string;
    fielder_position: string;
    target_base: string;
    tier: Tier;
    outs: number;
    runners_on: string;
    inning: number;
    half_inning: string;
    away_team: string;
    home_team: string;
    credit_chain: string;
    fetch_status: FetchStatus | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    gamePk: r.game_pk,
    playIndex: r.play_index,
    date: r.date,
    fielderPosition: r.fielder_position,
    targetBase: r.target_base,
    tier: r.tier,
    outs: r.outs,
    runnersOn: r.runners_on,
    inning: r.inning,
    halfInning: r.half_inning,
    awayTeam: r.away_team,
    homeTeam: r.home_team,
    creditChain: r.credit_chain,
    fetchStatus: r.fetch_status,
  }));
}

function querySnapshotsInWindow(
  db: Database,
  window: WeekWindow,
): VoteSnapshotRow[] {
  const rows = db
    .prepare(
      `
      SELECT s.game_pk, s.play_index, s.fire_count, s.trash_count, s.net_score,
             s.voter_count, s.tier_review_flagged
      FROM vote_snapshots s
      JOIN plays p ON p.game_pk = s.game_pk AND p.play_index = s.play_index
      WHERE p.date BETWEEN $from AND $to
      GROUP BY s.game_pk, s.play_index
      ORDER BY s.game_pk ASC, s.play_index ASC;
    `,
    )
    .all({ $from: window.weekStarting, $to: window.weekEnding }) as {
    game_pk: number;
    play_index: number;
    fire_count: number;
    trash_count: number;
    net_score: number;
    voter_count: number;
    tier_review_flagged: number;
  }[];
  return rows.map((r) => ({
    gamePk: r.game_pk,
    playIndex: r.play_index,
    fireCount: r.fire_count,
    trashCount: r.trash_count,
    netScore: r.net_score,
    voterCount: r.voter_count,
    tierReviewFlagged: r.tier_review_flagged === 1,
  }));
}

/**
 * Returns play_tag rows for plays inside the window, or `[]` when phase
 * 3 hasn't landed (the table doesn't exist yet).
 */
function queryTagsInWindow(db: Database, window: WeekWindow): PlayTagRow[] {
  try {
    const rows = db
      .prepare(
        `
        SELECT t.id, t.game_pk, t.play_index, t.tag_type, t.tag_value,
               t.comment_ts, t.comment_user_id, t.matched_text, t.received_at
        FROM play_tags t
        JOIN plays p ON p.game_pk = t.game_pk
          AND (t.play_index IS NULL OR p.play_index = t.play_index)
        WHERE p.date BETWEEN $from AND $to
        GROUP BY t.id
        ORDER BY t.received_at ASC;
      `,
      )
      .all({ $from: window.weekStarting, $to: window.weekEnding }) as {
      id: number;
      game_pk: number;
      play_index: number | null;
      tag_type: TagType;
      tag_value: string;
      comment_ts: string;
      comment_user_id: string;
      matched_text: string | null;
      received_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      gamePk: r.game_pk,
      playIndex: r.play_index,
      tagType: r.tag_type,
      tagValue: r.tag_value,
      commentTs: r.comment_ts,
      commentUserId: r.comment_user_id,
      matchedText: r.matched_text ?? "",
      receivedAt: r.received_at,
    }));
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table: play_tags")) {
      return [];
    }
    throw err;
  }
}

function queryGameHeaders(db: Database, window: WeekWindow): GameHeaderRef[] {
  const rows = db
    .prepare(
      `
      SELECT h.game_pk, h.channel, h.ts
      FROM slack_game_headers h
      JOIN (SELECT DISTINCT game_pk FROM plays WHERE date BETWEEN $from AND $to) p
        ON p.game_pk = h.game_pk;
    `,
    )
    .all({ $from: window.weekStarting, $to: window.weekEnding }) as {
    game_pk: number;
    channel: string;
    ts: string;
  }[];
  return rows.map((r) => ({ gamePk: r.game_pk, channel: r.channel, ts: r.ts }));
}

/** Set of prior digest `ts` values used to filter messages. */
function loadPriorDigestTimestamps(db: Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT posted_message_ts FROM agent_runs WHERE posted_message_ts IS NOT NULL;`,
    )
    .all() as { posted_message_ts: string }[];
  return new Set(rows.map((r) => r.posted_message_ts));
}

interface ConversationsRepliesResponse {
  messages?: { user?: string; text?: string; ts: string; thread_ts?: string }[];
}

/**
 * Hits `conversations.replies` for a single thread. Returns null on
 * non-ok / network failure so the caller can drop the game from the
 * bundle.
 */
async function fetchThreadReplies(
  config: SlackClientConfig,
  channel: string,
  ts: string,
  logger: Logger,
): Promise<ConversationsRepliesResponse | null> {
  if (!config.botToken) return null;
  return callSlackApi<ConversationsRepliesResponse>(
    "conversations.replies",
    { channel, ts, limit: 200 },
    config.botToken,
    logger,
    "form",
  );
}

/**
 * Truncates messages oldest-first until the running token estimate sits
 * at or below `PER_GAME_TOKEN_CAP`. Returns the kept messages and a
 * `truncated` flag.
 */
function applyTokenCap(
  messages: TranscriptMessage[],
): { kept: TranscriptMessage[]; truncated: boolean } {
  let totalChars = messages.reduce((acc, m) => acc + m.text.length, 0);
  let kept = messages;
  let truncated = false;
  while (totalChars / CHARS_PER_TOKEN > PER_GAME_TOKEN_CAP && kept.length > 0) {
    const dropped = kept[0]!;
    totalChars -= dropped.text.length;
    kept = kept.slice(1);
    truncated = true;
  }
  return { kept, truncated };
}

/**
 * Top-level gather — single async pass that returns everything the
 * prompt builder needs. The Slack API failure mode is per-game: a 5xx
 * on one thread excludes that game's transcript but doesn't abort the
 * run.
 */
export async function gather(
  db: Database,
  config: SlackClientConfig,
  window: WeekWindow,
  historyWeeks: number,
  logger: Logger,
): Promise<GatheredData> {
  const plays = queryPlaysInWindow(db, window);
  const snapshots = querySnapshotsInWindow(db, window);
  const tags = queryTagsInWindow(db, window);
  const headers = queryGameHeaders(db, window);

  const botUserId = await resolveBotUserId(config, logger);
  const priorDigestTs = loadPriorDigestTimestamps(db);

  const transcriptGames: TranscriptGame[] = [];
  const channelCorrections: TranscriptMessage[] = [];

  for (const header of headers) {
    const reply = await fetchThreadReplies(config, header.channel, header.ts, logger);
    if (!reply || !reply.messages || reply.messages.length === 0) {
      continue;
    }

    const filteredMessages: TranscriptMessage[] = [];
    for (const m of reply.messages) {
      if (!m.text || !m.ts) continue;
      const isBot = botUserId !== null && m.user === botUserId;
      if (isBot) continue;
      if (priorDigestTs.has(m.ts)) continue;
      if (m.thread_ts && priorDigestTs.has(m.thread_ts)) {
        channelCorrections.push({
          text: m.text,
          user: m.user ?? "",
          ts: m.ts,
        });
        continue;
      }
      filteredMessages.push({
        text: m.text,
        user: m.user ?? "",
        ts: m.ts,
      });
    }

    if (filteredMessages.length === 0) continue;

    const { kept, truncated } = applyTokenCap(filteredMessages);
    transcriptGames.push({
      gamePk: header.gamePk,
      headerTs: header.ts,
      truncated,
      messages: kept,
    });
  }

  const priorFindings = queryPriorFindings(db, window.weekStarting, historyWeeks);

  return {
    window,
    plays,
    snapshots,
    tags,
    transcript: buildTranscript(transcriptGames),
    channelCorrections,
    priorFindings,
    botUserId,
  };
}

/** Total votes (fire + trash) across all snapshots in the window. */
export function totalVotes(data: GatheredData): number {
  return data.snapshots.reduce(
    (acc, s) => acc + s.fireCount + s.trashCount,
    0,
  );
}
