/**
 * Bridge between the Savant video backfill loop and Slack.
 *
 * `runBackfillCycle` accepts an `onSuccess` callback per rescued play.
 * `makeBackfillNotifier` returns a function shaped for that callback that
 * re-renders the original game message and posts a thread reply linking to
 * the freshly available video.
 *
 * Concurrency: a per-game Promise map serializes updates so two backfill
 * rescues for the same game cannot race chat.update against each other.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../logger";
import type { BackfillSuccessEvent } from "../daemon/backfill";
import { queryPlays } from "../storage/db";
import {
  lookupSlackMessage,
  markSlackMessageUpdated,
} from "./slack-messages-store";
import {
  buildGameMessage,
  buildThreadReplyMessage,
} from "./slack-formatter";
import {
  updateMessage,
  postThreadReply,
  type SlackClientConfig,
} from "./slack-client";

/**
 * Builds the onSuccess callback for `runBackfillCycle`.
 *
 * The returned function:
 *   1. Looks up the original Slack message for the game (no-op if missing).
 *   2. Re-renders the full message from current DB state.
 *   3. Calls chat.update on the original ts.
 *   4. Posts a thread reply for the rescued play.
 *
 * Calls for the same gamePk are chained in order via `updateLocks`, so a
 * burst of rescues from one game can't interleave Slack writes.
 */
export function makeBackfillNotifier(
  db: Database,
  config: SlackClientConfig,
  logger: Logger,
): (event: BackfillSuccessEvent) => Promise<void> {
  const updateLocks = new Map<number, Promise<void>>();

  return async (event) => {
    const existing = updateLocks.get(event.gamePk);
    const next = (async () => {
      if (existing) await existing.catch(() => {});
      await applyUpdate(db, config, logger, event);
    })();
    updateLocks.set(event.gamePk, next);
    try {
      await next;
    } finally {
      if (updateLocks.get(event.gamePk) === next) {
        updateLocks.delete(event.gamePk);
      }
    }
  };
}

async function applyUpdate(
  db: Database,
  config: SlackClientConfig,
  logger: Logger,
  event: BackfillSuccessEvent,
): Promise<void> {
  const ref = lookupSlackMessage(db, event.gamePk);
  if (!ref) {
    logger.debug("no slack message ref for backfill rescue, skipping", {
      gamePk: event.gamePk,
    });
    return;
  }

  const allPlays = queryPlays(db, { gamePk: event.gamePk, limit: 200 });
  if (allPlays.length === 0) {
    logger.warn("backfill rescue: no plays found for game", {
      gamePk: event.gamePk,
    });
    return;
  }

  const updatePayload = buildGameMessage(allPlays);
  const updated = await updateMessage(
    config,
    ref.channel,
    ref.ts,
    updatePayload,
    logger,
  );
  if (!updated) {
    logger.warn("chat.update failed for backfill rescue", {
      gamePk: event.gamePk,
    });
    return;
  }
  markSlackMessageUpdated(db, event.gamePk);

  const rescuedPlay = allPlays.find(
    (p) =>
      p.gamePk === event.gamePk && p.playIndex === event.playIndex,
  );
  if (rescuedPlay) {
    const replyPayload = buildThreadReplyMessage(rescuedPlay, event);
    await postThreadReply(config, ref.channel, ref.ts, replyPayload, logger);
  } else {
    logger.warn("rescued play row not found, skipping thread reply", {
      gamePk: event.gamePk,
      playIndex: event.playIndex,
    });
  }
}
