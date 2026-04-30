/**
 * Slack delivery client.
 *
 * Two transports live here:
 *  - bot-token API (`chat.postMessage`, `chat.update`) — required for editing
 *    messages in place after a Savant video backfill rescue.
 *  - incoming webhook (`SLACK_WEBHOOK_URL`) — preserved as a fallback so a
 *    misconfigured deploy degrades to current behavior rather than silently
 *    dropping notifications.
 *
 * The mode is decided at call time by `determineSlackMode` based on which
 * env vars resolved at startup. Callers always invoke `postMessage`; the
 * transport choice is internal.
 */

import type { Logger } from "../logger";
import type { DetectedPlay } from "../types/play";
import type { SlackPayload } from "./slack-formatter";
import { buildGameMessage } from "./slack-formatter";

const SLACK_API_BASE = "https://slack.com/api";

/** Result of a successful chat.postMessage. */
export interface PostMessageResult {
  ok: true;
  channel: string;
  ts: string;
}

export interface SlackClientConfig {
  botToken?: string;
  channelId?: string;
  webhookUrl?: string;
}

export type SlackMode = "bot_token" | "webhook" | "disabled";

/**
 * Selects the active Slack transport based on configured env vars.
 *
 * Bot-token mode wins when both SLACK_BOT_TOKEN and SLACK_CHANNEL_ID are set,
 * since it unlocks message editing for backfill rescues.
 */
export function determineSlackMode(config: SlackClientConfig): SlackMode {
  if (config.botToken && config.channelId) return "bot_token";
  if (config.webhookUrl) return "webhook";
  return "disabled";
}

/** Base delay in milliseconds for exponential backoff (webhook fallback). */
const RETRY_BASE_DELAY_MS = 1000;

/** Maximum number of webhook delivery attempts. */
const MAX_RETRIES = 3;

/**
 * Issues a single POST to a slack.com/api method and returns the parsed body
 * when the API reports `ok: true`. All non-ok / 429 cases log and return null
 * so callers can degrade gracefully.
 */
async function callSlackApi<T>(
  method: string,
  body: Record<string, unknown>,
  botToken: string,
  logger: Logger,
): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("slack api request failed", { method, error: message });
    return null;
  }

  if (response.status === 429) {
    logger.warn("slack rate limited", {
      method,
      retryAfter: response.headers.get("retry-after"),
    });
    return null;
  }

  let json: { ok: boolean; error?: string } & Record<string, unknown>;
  try {
    json = (await response.json()) as { ok: boolean; error?: string } &
      Record<string, unknown>;
  } catch {
    logger.warn("slack api returned invalid json", { method, status: response.status });
    return null;
  }

  if (!json.ok) {
    logger.warn("slack api returned non-ok", { method, error: json.error });
    return null;
  }
  return json as unknown as T;
}

/**
 * Posts a brand-new message for a game.
 *
 * In bot-token mode returns the channel + ts that the daemon then records in
 * `slack_messages` so backfill rescues can find the message later. In webhook
 * mode the call goes out (with retries) but returns null because webhooks
 * have no addressable ts.
 */
export async function postMessage(
  config: SlackClientConfig,
  payload: SlackPayload,
  logger: Logger,
): Promise<PostMessageResult | null> {
  const mode = determineSlackMode(config);
  if (mode === "disabled") {
    logger.debug("slack disabled, skipping postMessage");
    return null;
  }

  if (mode === "bot_token") {
    return callSlackApi<PostMessageResult>(
      "chat.postMessage",
      { channel: config.channelId, blocks: payload.blocks },
      config.botToken!,
      logger,
    );
  }

  await sendWebhook(config.webhookUrl!, payload, logger);
  return null;
}

/**
 * Edits a previously posted message by ts. Re-renders the entire blocks
 * payload — never tries to patch a single field — and stamps last_updated_at
 * via the caller on success.
 */
export async function updateMessage(
  config: SlackClientConfig,
  channel: string,
  ts: string,
  payload: SlackPayload,
  logger: Logger,
): Promise<boolean> {
  if (!config.botToken) {
    logger.debug("updateMessage skipped: no bot token");
    return false;
  }
  const result = await callSlackApi<{ ok: true }>(
    "chat.update",
    { channel, ts, blocks: payload.blocks },
    config.botToken,
    logger,
  );
  return result !== null;
}

/**
 * Posts a reply in the thread of a previously posted message.
 *
 * Used by the backfill notifier to announce "video now available" without
 * spamming the channel — replies live inside the original message thread.
 */
export async function postThreadReply(
  config: SlackClientConfig,
  channel: string,
  threadTs: string,
  payload: SlackPayload,
  logger: Logger,
): Promise<boolean> {
  if (!config.botToken) {
    logger.debug("postThreadReply skipped: no bot token");
    return false;
  }
  const result = await callSlackApi<{ ok: true }>(
    "chat.postMessage",
    {
      channel,
      thread_ts: threadTs,
      blocks: payload.blocks,
    },
    config.botToken,
    logger,
  );
  return result !== null;
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
 * Per-game initial post helper used by the scheduler.
 *
 * Groups detected plays by gamePk so each game produces a single Slack
 * message, then routes the payload through `postMessage` (bot-token or
 * webhook fallback). Returns the per-game result so the caller can record
 * (channel, ts) tuples for later edits.
 */
export async function sendGameNotifications(
  plays: DetectedPlay[],
  config: SlackClientConfig,
  logger: Logger,
): Promise<{ gamePk: number; result: PostMessageResult | null }[]> {
  if (plays.length === 0) {
    logger.debug("no plays to notify about");
    return [];
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

  const results: { gamePk: number; result: PostMessageResult | null }[] = [];

  for (const [gamePk, gamePlays] of grouped) {
    const payload = buildGameMessage(gamePlays);
    logger.info("sending slack notification", {
      gamePk,
      playCount: gamePlays.length,
      mode: determineSlackMode(config),
    });

    const result = await postMessage(config, payload, logger);
    results.push({ gamePk, result });

    if (result) {
      logger.info("slack notification sent", {
        gamePk,
        channel: result.channel,
        ts: result.ts,
      });
    }
  }

  return results;
}
