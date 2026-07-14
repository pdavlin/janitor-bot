/**
 * Slack Block Kit formatters.
 *
 * Pure, delivery-agnostic builders for the messages our bot posts. The
 * actual transport (webhook vs bot-token API) lives in `slack-client.ts`.
 *
 * @example
 * ```ts
 * const payload = buildGameMessage(plays);
 * await postMessage(slackConfig, payload, logger);
 * ```
 */

import type { DetectedPlay, StoredPlay, Tier } from "../types/play";
import type { BackfillSuccessEvent } from "../daemon/backfill";
import { teamEmoji } from "./team-emoji";

/** Final score for a game, threaded from the scheduler through the formatter. */
export interface GameFinalScore {
  away: number;
  home: number;
}

/**
 * Resolves a throw velocity (mph) to the percent (0-100) of the season's
 * measured throws at or above it, or null when nothing is measured yet.
 * Injected by callers with DB access (queryVelocityTopShare) so this
 * module stays delivery-agnostic and DB-free.
 */
export type VelocityTopShareLookup = (velocityMph: number) => number | null;

/** Velocity at or above which the throw line gets the CANNON tag. */
const CANNON_THRESHOLD_MPH = 98;

/**
 * Top-share ceiling (percent) for the "(top X% this season)" flex —
 * only throws at or inside the season's top 10% (>= 90th percentile)
 * earn the line.
 */
const TOP_SHARE_FLEX_MAX_PCT = 10;

/** Emoji indicator mapped to each tier for visual color coding in Slack. */
const TIER_EMOJI: Record<Tier, string> = {
  high: ":red_circle:",
  medium: ":large_orange_circle:",
  low: ":white_circle:",
};

/** Tier label displayed next to the emoji. */
const TIER_LABEL: Record<Tier, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Numeric priority for tier comparison. Higher means more notable. */
const TIER_PRIORITY: Record<Tier, number> = {
  high: 2,
  medium: 1,
  low: 0,
};

/**
 * A single Slack Block Kit block element.
 *
 * Kept intentionally narrow to avoid importing Slack SDK types
 * while still providing compile-time safety for the blocks we build.
 */
interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
}

interface SlackBlock {
  type: "header" | "section" | "divider" | "actions" | "context";
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  elements?: SlackBlockElement[];
}

interface SlackButtonElement {
  type: "button";
  text: SlackTextObject;
  url: string;
  action_id: string;
}

interface SlackContextElement {
  type: "mrkdwn" | "plain_text";
  text: string;
}

type SlackBlockElement = SlackButtonElement | SlackContextElement;

export interface SlackPayload {
  blocks: SlackBlock[];
}

/**
 * Builds the velocity context line with its flex flavor:
 *
 *   - always: "Throw: 96 mph (Statcast)"
 *   - at 98+ mph: append " 🔫 CANNON"
 *   - in the season's top 10% of measured throws (when a lookup is
 *     provided): append " (top X% this season)", X >= 1
 *
 * The CANNON rule compares the rounded value so the tag always matches
 * the rendered number (97.7 renders as "98 mph" and earns the tag).
 * The percentile lookup fails soft: the flex is decoration, so a lookup
 * error (e.g. SQLITE_BUSY mid-posting-loop) must degrade to the plain
 * velocity line rather than abort the remaining posts.
 *
 * @param velocityMph - Positive measured throw velocity.
 * @param velocityTopShare - Optional season top-share lookup.
 */
function buildVelocityLine(
  velocityMph: number,
  velocityTopShare?: VelocityTopShareLookup,
): string {
  const displayMph = Math.round(velocityMph);
  let line = `Throw: ${displayMph} mph (Statcast)`;
  if (displayMph >= CANNON_THRESHOLD_MPH) {
    line += " 🔫 CANNON";
  }
  let topShare: number | null = null;
  try {
    topShare = velocityTopShare?.(velocityMph) ?? null;
  } catch {
    // Fail soft: the caller-side lookup (makeVelocityTopShareLookup) logs
    // the error; a decoration must never take down a message post.
    topShare = null;
  }
  if (topShare != null && topShare <= TOP_SHARE_FLEX_MAX_PCT) {
    line += ` (top ${Math.max(1, Math.ceil(topShare))}% this season)`;
  }
  return line;
}

/**
 * Formats a half-inning string into a human-readable label.
 *
 * @param halfInning - "top" or "bottom"
 * @param inning - Inning number
 * @returns Formatted string like "Top 7" or "Bot 3"
 */
function formatInning(halfInning: string, inning: number): string {
  const prefix = halfInning === "top" ? "Top" : "Bot";
  return `${prefix} ${inning}`;
}

/**
 * Formats outs and runner positions into a compact situation string.
 *
 * @returns e.g. "1 out, R1 R2" or "0 out, bases empty"
 */
export function formatSituation(outs: number, runnersOn: string): string {
  const outsText = `${outs} out`;
  const runnersText = runnersOn
    ? runnersOn.split(", ").map((b) => `R${b.charAt(0)}`).join(" ")
    : "bases empty";
  return `${outsText}, ${runnersText}`;
}

/**
 * Builds a set of Block Kit blocks for a single detected play.
 *
 * Each play renders as a section with fielder info, play description,
 * score context, and an optional video button.
 *
 * @param play - The detected outfield assist play
 * @param velocityTopShare - Optional season-percentile lookup for the
 *   velocity flex line; omit to render the plain velocity line.
 * @returns Array of Slack blocks representing this play
 */
function buildPlayBlocks(
  play: DetectedPlay | StoredPlay,
  velocityTopShare?: VelocityTopShareLookup,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const tierEmoji = TIER_EMOJI[play.tier];
  const tierLabel = TIER_LABEL[play.tier];

  blocks.push({
    type: "section",
    fields: [
      {
        type: "mrkdwn",
        text: `*Fielder:* ${play.fielderName} (${play.fielderPosition})`,
      },
      {
        type: "mrkdwn",
        text: `*Tier:* ${tierEmoji} ${tierLabel}`,
      },
      {
        type: "mrkdwn",
        text: `*Credit Chain:* ${play.creditChain}`,
      },
      {
        type: "mrkdwn",
        text: `*Target Base:* ${play.targetBase}`,
      },
    ],
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: play.description,
    },
  });

  // Throw velocity annotation from Statcast arm-strength data.
  // Guard > 0 defensively: untracked throws are null, but never render a
  // non-positive value as a velocity.
  const velocityLine =
    play.throwVelocity != null && play.throwVelocity > 0
      ? buildVelocityLine(play.throwVelocity, velocityTopShare)
      : null;

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: velocityLine
          ? `${formatInning(play.halfInning, play.inning)} | ${formatSituation(play.outs, play.runnersOn)} | ${play.awayTeam} ${play.awayScore} - ${play.homeTeam} ${play.homeScore} at the time\n${velocityLine}`
          : `${formatInning(play.halfInning, play.inning)} | ${formatSituation(play.outs, play.runnersOn)} | ${play.awayTeam} ${play.awayScore} - ${play.homeTeam} ${play.homeScore} at the time`,
      },
    ],
  });

  if (play.videoUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: play.videoTitle ?? "Watch Video",
            emoji: true,
          },
          url: play.videoUrl,
          action_id: `video_${play.gamePk}_${play.playIndex}`,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Builds a complete Slack Block Kit payload for a group of plays
 * from the same game.
 *
 * The message includes a header with the team matchup, followed by
 * individual play sections separated by dividers.
 *
 * @param plays - Array of DetectedPlay objects from the same game.
 *   Caller is responsible for ensuring all plays share the same gamePk.
 * @param velocityTopShare - Optional season-percentile lookup for the
 *   velocity flex line.
 * @returns Slack Block Kit payload ready for webhook POST or chat.postMessage
 */
export function buildGameMessage(
  plays: DetectedPlay[],
  velocityTopShare?: VelocityTopShareLookup,
): SlackPayload {
  if (plays.length === 0) {
    return { blocks: [] };
  }

  const first = plays[0];
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `${first.awayTeam} @ ${first.homeTeam}`,
      emoji: true,
    },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${plays.length} outfield assist${plays.length > 1 ? "s" : ""} detected | ${first.date}`,
      },
    ],
  });

  for (let i = 0; i < plays.length; i++) {
    blocks.push({ type: "divider" });
    blocks.push(...buildPlayBlocks(plays[i], velocityTopShare));
  }

  // Slack Block Kit enforces a 50-block maximum per message.
  // If we exceed it, truncate play blocks and append a notice.
  const SLACK_BLOCK_LIMIT = 50;
  if (blocks.length > SLACK_BLOCK_LIMIT) {
    // Reserve one slot for the truncation notice
    const truncated = blocks.slice(0, SLACK_BLOCK_LIMIT - 1);
    truncated.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Message truncated. ${plays.length} plays detected but only a subset is shown due to Slack limits._`,
        },
      ],
    });
    return { blocks: truncated };
  }

  return { blocks };
}

/**
 * Builds the bot-token-mode header for a game: bold team abbrev + custom team
 * emoji + final score, rendered as a single mrkdwn section followed by a
 * context block summarizing the assist count and date.
 *
 * Slack's `header` block is plain_text and does not render emoji shortcodes
 * inside its text, so the header uses `section`/`mrkdwn` instead. A `*X*`
 * pair surrounds each abbrev for bold, and the literal "@" separator avoids
 * any ambiguity with the bold markers.
 *
 * When a team abbrev has no emoji mapping the renderer degrades to bold-only
 * (no `:undefined:` placeholder).
 */
export function buildGameHeaderMessage(
  plays: DetectedPlay[],
  score: GameFinalScore,
): SlackPayload {
  if (plays.length === 0) {
    return { blocks: [] };
  }
  const first = plays[0];
  const awayEmoji = teamEmoji(first.awayTeam);
  const homeEmoji = teamEmoji(first.homeTeam);

  const awayPart = awayEmoji
    ? `*${first.awayTeam}* :${awayEmoji}: ${score.away}`
    : `*${first.awayTeam}* ${score.away}`;
  const homePart = homeEmoji
    ? `${score.home} :${homeEmoji}: *${first.homeTeam}*`
    : `${score.home} *${first.homeTeam}*`;

  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${awayPart} @ ${homePart}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${plays.length} outfield assist${plays.length > 1 ? "s" : ""} detected | ${first.date}`,
          },
        ],
      },
    ],
  };
}

/**
 * Builds a single play's blocks for use as a thread reply under the game
 * header in bot-token mode.
 *
 * @param velocityTopShare - Optional season-percentile lookup for the
 *   velocity flex line.
 */
export function buildPlayReplyMessage(
  play: DetectedPlay | StoredPlay,
  velocityTopShare?: VelocityTopShareLookup,
): SlackPayload {
  return { blocks: buildPlayBlocks(play, velocityTopShare) };
}

/**
 * Builds the thread reply that announces a Savant video has been rescued
 * after the original post went out without one.
 */
export function buildThreadReplyMessage(
  play: StoredPlay,
  event: BackfillSuccessEvent,
): SlackPayload {
  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:movie_camera: *Video now available* — ${play.fielderName} (${play.fielderPosition}) → ${play.targetBase}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Watch", emoji: true },
            url: event.videoUrl,
            action_id: `backfill_video_${event.gamePk}_${event.playIndex}`,
          },
        ],
      },
    ],
  };
}

/**
 * Filters plays by minimum tier threshold.
 *
 * Tier hierarchy: high > medium > low.
 * - minTier "high" returns only high-tier plays
 * - minTier "medium" returns high and medium
 * - minTier "low" or undefined returns all plays
 *
 * @param plays - Array of detected plays to filter
 * @param minTier - Minimum tier threshold, or undefined for no filtering
 * @returns Filtered array of plays meeting the tier threshold
 */
export function filterByMinTier(
  plays: DetectedPlay[],
  minTier: Tier | undefined,
): DetectedPlay[] {
  if (minTier === undefined || minTier === "low") {
    return plays;
  }

  const threshold = TIER_PRIORITY[minTier];
  return plays.filter((play) => TIER_PRIORITY[play.tier] >= threshold);
}
