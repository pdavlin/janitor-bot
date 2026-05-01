/**
 * Persistence helpers for the `slack_messages` table.
 *
 * Each row binds a gamePk to the Slack channel + ts of the originally posted
 * notification. The backfill notifier looks up these references when it needs
 * to call `chat.update` after a Savant video rescue.
 */

import type { Database } from "bun:sqlite";

/** Reference to a posted Slack message, used as the target for chat.update. */
export interface SlackMessageRef {
  channel: string;
  ts: string;
}

/**
 * Records the channel + ts of a freshly posted message for a game.
 *
 * Idempotent on `game_pk`: if a row already exists (e.g. the daemon
 * restarted and re-detected the same game), the latest channel/ts wins
 * and `last_updated_at` resets to NULL because the new message has not
 * yet been edited.
 */
export function recordSlackMessage(
  db: Database,
  gamePk: number,
  channel: string,
  ts: string,
): void {
  db.prepare(`
    INSERT INTO slack_messages (game_pk, channel, ts, posted_at, last_updated_at)
    VALUES ($gamePk, $channel, $ts, datetime('now'), NULL)
    ON CONFLICT(game_pk) DO UPDATE SET
      channel = excluded.channel,
      ts = excluded.ts,
      posted_at = excluded.posted_at,
      last_updated_at = NULL;
  `).run({ $gamePk: gamePk, $channel: channel, $ts: ts });
}

/**
 * Looks up the Slack message reference for a gamePk. Returns null when the
 * game was never posted via the bot-token path (webhook fallback or disabled).
 */
export function lookupSlackMessage(
  db: Database,
  gamePk: number,
): SlackMessageRef | null {
  const row = db
    .prepare(`SELECT channel, ts FROM slack_messages WHERE game_pk = $gamePk;`)
    .get({ $gamePk: gamePk }) as { channel: string; ts: string } | null;
  return row ? { channel: row.channel, ts: row.ts } : null;
}

/**
 * Stamps `last_updated_at` to now for the given gamePk. Called after a
 * successful chat.update so we have a record that the message has been
 * edited at least once since posting.
 */
export function markSlackMessageUpdated(
  db: Database,
  gamePk: number,
): void {
  db.prepare(`
    UPDATE slack_messages SET last_updated_at = datetime('now') WHERE game_pk = $gamePk;
  `).run({ $gamePk: gamePk });
}
