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
 * @returns Array of Slack blocks representing this play
 */
function buildPlayBlocks(play: DetectedPlay): SlackBlock[] {
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

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${formatInning(play.halfInning, play.inning)} | ${formatSituation(play.outs, play.runnersOn)} | ${play.awayTeam} ${play.awayScore} - ${play.homeTeam} ${play.homeScore}`,
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
 * @returns Slack Block Kit payload ready for webhook POST or chat.postMessage
 */
export function buildGameMessage(plays: DetectedPlay[]): SlackPayload {
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
    blocks.push(...buildPlayBlocks(plays[i]));
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
