/**
 * Slack Events API plumbing.
 *
 * Three responsibilities live here:
 *   1. Verifying request signatures with the signing secret (HMAC-SHA256)
 *   2. Deduplicating events by their `event_id` (in-memory LRU)
 *   3. Dispatching `reaction_added` / `reaction_removed` events to the vote
 *      log after resolving the target play and verifying the reactor.
 *
 * Signature verification uses constant-time comparison to avoid leaking
 * timing information about partial matches.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Logger } from "../logger";
import { lookupPlayMessageByTs } from "./slack-messages-store";
import {
  insertVoteEvent,
  isPostWindow,
  reactionToDirection,
} from "./slack-votes-store";
import { lookupFindingMessageByTs } from "./slack-finding-messages-store";
import {
  insertFindingResolutionEvent,
  isFindingPostWindow,
  reactionToResolutionDirection,
  type ResolutionDirection,
} from "./finding-resolution-events-store";
import { getUserInfo, isVotingEligible } from "./slack-user-cache";
import type { SlackClientConfig } from "./slack-client";
import { attributeToPlay, parseTags } from "./comment-tags";
import { insertPlayTag } from "./play-tags-store";

/** Slack rejects timestamps drifting more than five minutes from now. */
const FIVE_MINUTES_S = 60 * 5;

/**
 * Verifies a Slack Events API request signature.
 *
 * Process:
 *   - Build base string `v0:{timestamp}:{rawBody}`
 *   - HMAC-SHA256 with the signing secret, hex digest, prefix `v0=`
 *   - Constant-time compare against the `x-slack-signature` header
 *
 * Replay protection: timestamps drifting more than 5 minutes from now are
 * rejected outright before the HMAC compare.
 *
 * @returns true only when the signature is well-formed, fresh, and matches.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  rawBody: string,
): boolean {
  if (!timestampHeader || !signatureHeader) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > FIVE_MINUTES_S) return false;

  const base = `v0:${timestampHeader}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(base)
    .digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

const eventIdLru = new Set<string>();
const EVENT_LRU_MAX = 2048;

/**
 * Records an event_id and reports whether it has been seen recently.
 *
 * The LRU is a Set with iteration-order eviction: when full, the oldest
 * entry is dropped. Bot restart clears the LRU; Slack retries on non-200
 * so a single re-process post-restart is harmless given the vote log's
 * append-only design.
 *
 * @returns true when the event_id was already seen (caller should ack and skip).
 */
export function isDuplicateEvent(eventId: string): boolean {
  if (eventIdLru.has(eventId)) return true;
  eventIdLru.add(eventId);
  if (eventIdLru.size > EVENT_LRU_MAX) {
    const oldest = eventIdLru.values().next().value;
    if (oldest !== undefined) eventIdLru.delete(oldest);
  }
  return false;
}

/** Test helper: empty the dedupe LRU. */
export function clearEventLru(): void {
  eventIdLru.clear();
}

// ---------------------------------------------------------------------------
// Event payload types (subset of Slack's Events API)
// ---------------------------------------------------------------------------

interface ReactionItem {
  type: string;
  channel: string;
  ts: string;
}

export type SlackEvent =
  | {
      type: "reaction_added";
      user: string;
      reaction: string;
      item: ReactionItem;
      event_ts: string;
    }
  | {
      type: "reaction_removed";
      user: string;
      reaction: string;
      item: ReactionItem;
      event_ts: string;
    }
  | {
      type: "message";
      subtype?: string;
      user?: string;
      text?: string;
      ts: string;
      thread_ts?: string;
      channel: string;
    };

export interface SlackEventEnvelope {
  type: "url_verification" | "event_callback";
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface DispatchContext {
  db: Database;
  logger: Logger;
  slackConfig: SlackClientConfig;
}

/**
 * Routes a verified `event_callback` envelope to the right handler.
 *
 * Currently only reaction events are processed; everything else is a no-op.
 * Errors are caught at the top level and logged so a malformed event from
 * Slack can never crash the dispatch loop.
 */
export async function dispatchEvent(
  envelope: SlackEventEnvelope,
  ctx: DispatchContext,
): Promise<void> {
  try {
    if (envelope.type !== "event_callback" || !envelope.event) return;
    const event = envelope.event;
    if (event.type === "reaction_added" || event.type === "reaction_removed") {
      await handleReactionEvent(event, ctx);
      return;
    }
    if (event.type === "message") {
      handleMessageEvent(event, ctx);
      return;
    }
  } catch (err) {
    ctx.logger.error("dispatch event failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleReactionEvent(
  event: Extract<
    SlackEvent,
    { type: "reaction_added" | "reaction_removed" }
  >,
  ctx: DispatchContext,
): Promise<void> {
  const playDirection = reactionToDirection(event.reaction);
  if (playDirection) {
    await handlePlayVoteReaction(event, playDirection, ctx);
    return;
  }

  const resolutionDirection = reactionToResolutionDirection(event.reaction);
  if (resolutionDirection) {
    await handleFindingResolutionReaction(event, resolutionDirection, ctx);
    return;
  }
}

async function handlePlayVoteReaction(
  event: Extract<
    SlackEvent,
    { type: "reaction_added" | "reaction_removed" }
  >,
  direction: "fire" | "trash",
  ctx: DispatchContext,
): Promise<void> {
  const lookup = lookupPlayMessageByTs(ctx.db, event.item.channel, event.item.ts);
  if (!lookup) return;

  const userInfo = await getUserInfo(ctx.slackConfig, event.user, ctx.logger);
  if (!isVotingEligible(userInfo)) return;

  const postWindow = isPostWindow(ctx.db, lookup.gamePk, lookup.playIndex);

  try {
    insertVoteEvent(ctx.db, {
      userId: event.user,
      gamePk: lookup.gamePk,
      playIndex: lookup.playIndex,
      direction,
      action: event.type === "reaction_added" ? "added" : "removed",
      eventTs: event.event_ts,
      postWindow,
    });
  } catch (err) {
    ctx.logger.error("vote insert failed", {
      gamePk: lookup.gamePk,
      playIndex: lookup.playIndex,
      direction,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleFindingResolutionReaction(
  event: Extract<
    SlackEvent,
    { type: "reaction_added" | "reaction_removed" }
  >,
  direction: ResolutionDirection,
  ctx: DispatchContext,
): Promise<void> {
  const lookup = lookupFindingMessageByTs(
    ctx.db,
    event.item.channel,
    event.item.ts,
  );
  if (!lookup) return;

  const userInfo = await getUserInfo(ctx.slackConfig, event.user, ctx.logger);
  if (!isVotingEligible(userInfo)) return;

  const postWindow = isFindingPostWindow(ctx.db, lookup.findingId);

  try {
    insertFindingResolutionEvent(ctx.db, {
      findingId: lookup.findingId,
      userId: event.user,
      direction,
      action: event.type === "reaction_added" ? "added" : "removed",
      eventTs: event.event_ts,
      postWindow,
    });
  } catch (err) {
    ctx.logger.error("finding resolution insert failed", {
      findingId: lookup.findingId,
      direction,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Routes a thread-reply `message` event to the keyword tag pipeline.
 *
 * Filters in order:
 *   - skip edits/deletes (`message_changed`, `message_deleted`)
 *   - require a `thread_ts` distinct from `ts` (must be a real reply)
 *   - require user + text (bot/system messages elide these)
 *   - require the parent ts to match a known game header
 *
 * After parsing tags, attribution prefers the play whose fielder is uniquely
 * named in the comment; otherwise the tag is recorded at the game level
 * (`play_index = NULL`).
 */
function handleMessageEvent(
  event: Extract<SlackEvent, { type: "message" }>,
  ctx: DispatchContext,
): void {
  if (event.subtype === "message_changed" || event.subtype === "message_deleted") return;
  if (!event.thread_ts || event.thread_ts === event.ts) return;
  if (!event.user || !event.text) return;

  const headerRow = ctx.db
    .prepare(
      `SELECT game_pk FROM slack_game_headers WHERE channel = $channel AND ts = $ts LIMIT 1;`,
    )
    .get({ $channel: event.channel, $ts: event.thread_ts }) as
    | { game_pk: number }
    | null;
  if (!headerRow) return;

  const tags = parseTags(event.text);
  if (tags.length === 0) return;

  const fielders = ctx.db
    .prepare(
      `SELECT DISTINCT play_index, fielder_name FROM plays WHERE game_pk = $gamePk;`,
    )
    .all({ $gamePk: headerRow.game_pk }) as
    { play_index: number; fielder_name: string }[];

  const playIndex = attributeToPlay(
    event.text,
    fielders.map((f) => ({ fielderName: f.fielder_name, playIndex: f.play_index })),
  );

  for (const tag of tags) {
    try {
      insertPlayTag(ctx.db, {
        gamePk: headerRow.game_pk,
        playIndex,
        tagType: tag.type,
        tagValue: tag.value,
        commentTs: event.ts,
        commentUserId: event.user,
        matchedText: tag.matchedText,
      });
    } catch (err) {
      ctx.logger.error("play tag insert failed", {
        gamePk: headerRow.game_pk,
        playIndex,
        tagType: tag.type,
        tagValue: tag.value,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
