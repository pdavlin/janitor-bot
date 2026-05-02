/**
 * Bridge between the Savant video backfill loop and Slack.
 *
 * `runBackfillCycle` accepts an `onSuccess` callback per rescued play.
 * `makeBackfillNotifier` returns a function shaped for that callback that
 * edits the rescued play's thread reply (not the whole game header) and
 * posts an announcement reply under the game's header thread.
 *
 * Concurrency: a per-(gamePk, playIndex) Promise map serializes updates so
 * two backfill rescues for the same play cannot race chat.update against
 * each other. Different plays in the same game can run concurrently.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../logger";
import type { BackfillSuccessEvent } from "../daemon/backfill";
import { queryPlays } from "../storage/db";
import {
  lookupPlayMessage,
  markPlayMessageUpdated,
} from "./slack-messages-store";
import {
  buildPlayReplyMessage,
  buildThreadReplyMessage,
} from "./slack-formatter";
import {
  updateMessage,
  postThreadReply,
  type SlackClientConfig,
} from "./slack-client";

/** Composite key for the per-play update lock map. */
function lockKey(gamePk: number, playIndex: number): string {
  return `${gamePk}:${playIndex}`;
}

/**
 * Builds the onSuccess callback for `runBackfillCycle`.
 *
 * The returned function:
 *   1. Looks up the per-play thread reply (no-op if missing).
 *   2. Re-renders only that play's blocks from current DB state.
 *   3. Calls chat.update on the play reply ts.
 *   4. Posts an announcement reply under the game's header thread.
 *
 * Calls for the same (gamePk, playIndex) are chained in order via
 * `updateLocks`, so a burst of rescues for one play can't interleave Slack
 * writes. Different plays in the same game are independent.
 */
export function makeBackfillNotifier(
  db: Database,
  config: SlackClientConfig,
  logger: Logger,
): (event: BackfillSuccessEvent) => Promise<void> {
  const updateLocks = new Map<string, Promise<void>>();

  return async (event) => {
    const key = lockKey(event.gamePk, event.playIndex);
    const existing = updateLocks.get(key);
    const next = (async () => {
      if (existing) await existing.catch(() => {});
      await applyUpdate(db, config, logger, event);
    })();
    updateLocks.set(key, next);
    try {
      await next;
    } finally {
      if (updateLocks.get(key) === next) {
        updateLocks.delete(key);
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
  const ref = lookupPlayMessage(db, event.gamePk, event.playIndex);
  if (!ref) {
    logger.debug("no play message ref for backfill rescue, skipping", {
      gamePk: event.gamePk,
      playIndex: event.playIndex,
    });
    return;
  }

  const allPlays = queryPlays(db, { gamePk: event.gamePk, limit: 200 });
  const play = allPlays.find(
    (p) => p.gamePk === event.gamePk && p.playIndex === event.playIndex,
  );
  if (!play) {
    logger.warn("rescued play row not found", {
      gamePk: event.gamePk,
      playIndex: event.playIndex,
    });
    return;
  }

  const updated = await updateMessage(
    config,
    ref.channel,
    ref.ts,
    buildPlayReplyMessage(play),
    logger,
  );
  if (!updated) {
    logger.warn("chat.update failed for play rescue", {
      gamePk: event.gamePk,
      playIndex: event.playIndex,
    });
    return;
  }
  markPlayMessageUpdated(db, event.gamePk, event.playIndex);

  const replyPayload = buildThreadReplyMessage(play, event);
  await postThreadReply(config, ref.channel, ref.parentTs, replyPayload, logger);
}
