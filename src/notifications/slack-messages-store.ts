/**
 * Persistence helpers for the Slack-message tables.
 *
 * Two tables back this module:
 *   - slack_game_headers   : 1 row per gamePk, the parent message ts.
 *   - slack_play_messages  : 1 row per (gamePk, playIndex), the thread reply
 *                            ts and a denormalized parent_ts for fast access.
 *
 * The backfill notifier looks up a play's reply ts to call chat.update on it
 * after a Savant rescue. The reaction handler in phase 2 walks the reverse
 * (channel, ts) -> (gamePk, playIndex) lookup to attribute votes.
 */

import type { Database } from "bun:sqlite";

/** Reference to the parent header message for a game. */
export interface SlackGameHeaderRef {
  channel: string;
  ts: string;
}

/** Reference to a single play's thread reply, with its parent header ts. */
export interface SlackPlayMessageRef {
  channel: string;
  ts: string;
  parentTs: string;
}

/**
 * Records the channel + ts of a freshly posted game header.
 *
 * Idempotent on `game_pk`: a re-detection upserts the latest channel/ts and
 * resets `last_updated_at` to NULL because the new message has not yet been
 * edited.
 */
export function recordGameHeader(
  db: Database,
  gamePk: number,
  channel: string,
  ts: string,
): void {
  db.prepare(`
    INSERT INTO slack_game_headers (game_pk, channel, ts, posted_at, last_updated_at)
    VALUES ($gamePk, $channel, $ts, datetime('now'), NULL)
    ON CONFLICT(game_pk) DO UPDATE SET
      channel = excluded.channel,
      ts = excluded.ts,
      posted_at = excluded.posted_at,
      last_updated_at = NULL;
  `).run({ $gamePk: gamePk, $channel: channel, $ts: ts });
}

/**
 * Looks up the header reference for a gamePk. Returns null when the game was
 * never posted via the bot-token path (webhook fallback or disabled).
 */
export function lookupGameHeader(
  db: Database,
  gamePk: number,
): SlackGameHeaderRef | null {
  const row = db
    .prepare(`SELECT channel, ts FROM slack_game_headers WHERE game_pk = $gamePk;`)
    .get({ $gamePk: gamePk }) as { channel: string; ts: string } | null;
  return row ? { channel: row.channel, ts: row.ts } : null;
}

/**
 * Stamps `last_updated_at` to now for the header row of a gamePk.
 */
export function markGameHeaderUpdated(db: Database, gamePk: number): void {
  db.prepare(`
    UPDATE slack_game_headers SET last_updated_at = datetime('now') WHERE game_pk = $gamePk;
  `).run({ $gamePk: gamePk });
}

/**
 * Records the channel + ts of a freshly posted per-play thread reply.
 *
 * Idempotent on (game_pk, play_index): a re-detection upserts and clears
 * last_updated_at because the new reply has not yet been edited.
 */
export function recordPlayMessage(
  db: Database,
  gamePk: number,
  playIndex: number,
  channel: string,
  ts: string,
  parentTs: string,
): void {
  db.prepare(`
    INSERT INTO slack_play_messages (game_pk, play_index, channel, ts, parent_ts, posted_at, last_updated_at)
    VALUES ($gamePk, $playIndex, $channel, $ts, $parentTs, datetime('now'), NULL)
    ON CONFLICT(game_pk, play_index) DO UPDATE SET
      channel = excluded.channel,
      ts = excluded.ts,
      parent_ts = excluded.parent_ts,
      posted_at = excluded.posted_at,
      last_updated_at = NULL;
  `).run({
    $gamePk: gamePk,
    $playIndex: playIndex,
    $channel: channel,
    $ts: ts,
    $parentTs: parentTs,
  });
}

/**
 * Looks up the per-play thread reply reference for a (gamePk, playIndex).
 * Returns null when no play reply was recorded.
 */
export function lookupPlayMessage(
  db: Database,
  gamePk: number,
  playIndex: number,
): SlackPlayMessageRef | null {
  const row = db
    .prepare(`
      SELECT channel, ts, parent_ts FROM slack_play_messages
      WHERE game_pk = $gamePk AND play_index = $playIndex;
    `)
    .get({ $gamePk: gamePk, $playIndex: playIndex }) as
    | { channel: string; ts: string; parent_ts: string }
    | null;
  return row
    ? { channel: row.channel, ts: row.ts, parentTs: row.parent_ts }
    : null;
}

/**
 * Reverse lookup from a (channel, ts) — used by phase 2 to map an incoming
 * Slack reaction event back to the (gamePk, playIndex) it belongs to.
 */
export function lookupPlayMessageByTs(
  db: Database,
  channel: string,
  ts: string,
): { gamePk: number; playIndex: number } | null {
  const row = db
    .prepare(`
      SELECT game_pk, play_index FROM slack_play_messages
      WHERE channel = $channel AND ts = $ts;
    `)
    .get({ $channel: channel, $ts: ts }) as
    | { game_pk: number; play_index: number }
    | null;
  return row ? { gamePk: row.game_pk, playIndex: row.play_index } : null;
}

/**
 * Stamps `last_updated_at` to now for the per-play row of a (gamePk, playIndex).
 */
export function markPlayMessageUpdated(
  db: Database,
  gamePk: number,
  playIndex: number,
): void {
  db.prepare(`
    UPDATE slack_play_messages
    SET last_updated_at = datetime('now')
    WHERE game_pk = $gamePk AND play_index = $playIndex;
  `).run({ $gamePk: gamePk, $playIndex: playIndex });
}
