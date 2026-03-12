/**
 * Slack webhook notification module for outfield assist alerts.
 *
 * Sends Block Kit formatted messages to a Slack webhook when outfield
 * assists are detected. Supports batching multiple plays from the same
 * game into a single message to reduce noise.
 *
 * @example
 * ```ts
 * const plays: DetectedPlay[] = [...];
 * const sent = await sendSlackNotifications(plays, webhookUrl, logger);
 * logger.info("notifications sent", { count: sent });
 * ```
 */

import type { DetectedPlay, Tier } from "../types/play";
import type { Logger } from "../logger";

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

/** Base delay in milliseconds for exponential backoff. */
const RETRY_BASE_DELAY_MS = 1000;

/** Maximum number of webhook delivery attempts. */
const MAX_RETRIES = 3;

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

interface SlackPayload {
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
        text: `${formatInning(play.halfInning, play.inning)} | ${play.awayTeam} ${play.awayScore} - ${play.homeTeam} ${play.homeScore}`,
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
 * @returns Slack Block Kit payload ready for webhook POST
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
 * Sends a JSON payload to a Slack webhook URL with retry logic.
 *
 * Makes up to 3 attempts with exponential backoff (1s, 2s) between
 * attempts on non-2xx responses or network errors.
 *
 * @param url - Slack incoming webhook URL
 * @param payload - JSON-serializable payload to POST
 * @param logger - Logger instance for diagnostics
 * @returns true if the webhook accepted the payload, false after all retries exhausted
 */
export async function sendWebhook(
  url: string,
  payload: unknown,
  logger: Logger,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return true;
      }

      const body = await response.text();
      logger.warn("slack webhook returned non-2xx", {
        status: response.status,
        body,
        attempt: attempt + 1,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("slack webhook request failed", {
        error: message,
        attempt: attempt + 1,
      });
    }

    if (attempt < MAX_RETRIES - 1) {
      const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await Bun.sleep(delayMs);
    }
  }

  logger.error("slack webhook delivery failed after all retries", {
    maxRetries: MAX_RETRIES,
  });
  return false;
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

/**
 * Sends Slack notifications for a batch of detected outfield assists.
 *
 * Groups plays by gamePk so each game produces a single Slack message,
 * reducing channel noise when multiple assists occur in the same game.
 *
 * @param plays - All detected plays to notify about
 * @param webhookUrl - Slack incoming webhook URL
 * @param logger - Logger instance for diagnostics
 * @returns Number of game messages sent successfully
 */
export async function sendSlackNotifications(
  plays: DetectedPlay[],
  webhookUrl: string,
  logger: Logger,
): Promise<number> {
  if (plays.length === 0) {
    logger.debug("no plays to notify about");
    return 0;
  }

  const grouped = new Map<number, DetectedPlay[]>();
  for (const play of plays) {
    const existing = grouped.get(play.gamePk);
    if (existing) {
      existing.push(play);
    } else {
      grouped.set(play.gamePk, [play]);
    }
  }

  let successCount = 0;

  for (const [gamePk, gamePlays] of grouped) {
    const payload = buildGameMessage(gamePlays);
    logger.info("sending slack notification", {
      gamePk,
      playCount: gamePlays.length,
    });

    const ok = await sendWebhook(webhookUrl, payload, logger);
    if (ok) {
      successCount++;
      logger.info("slack notification sent", { gamePk });
    } else {
      logger.error("slack notification failed", { gamePk });
    }
  }

  return successCount;
}
