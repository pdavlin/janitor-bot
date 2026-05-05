/**
 * Persistence helpers for the vote-event log and the per-play snapshot table.
 *
 * The `votes` table is append-only. One row is written per Slack
 * reaction_added / reaction_removed event. Tally is computed on read by
 * folding the event log per (user_id, direction) so an add/remove/re-add
 * sequence still yields the right final state.
 *
 * The `vote_snapshots` table is the locked view of a play's tally once its
 * 24-hour post window has elapsed. The snapshot job in src/daemon/snapshot-job.ts
 * is the only writer.
 */

import type { Database } from "bun:sqlite";

/** A reaction direction the bot recognises as a vote. */
export type VoteDirection = "fire" | "trash";

/** Slack reaction events come in two flavours: added and removed. */
export type VoteAction = "added" | "removed";

const REACTION_TO_DIRECTION: Record<string, VoteDirection> = {
  fire: "fire",
  wastebasket: "trash",
};

/**
 * Maps a Slack reaction name to a vote direction. Returns null when the
 * reaction is not a recognised vote (any other emoji is ignored).
 */
export function reactionToDirection(reaction: string): VoteDirection | null {
  return REACTION_TO_DIRECTION[reaction] ?? null;
}

/** Single reaction event ready to insert into the vote log. */
export interface VoteEvent {
  userId: string;
  gamePk: number;
  playIndex: number;
  direction: VoteDirection;
  action: VoteAction;
  /** Slack `event_ts` from the envelope; preserved verbatim. */
  eventTs: string;
  /** True when the reaction arrived after the 24h snapshot window. */
  postWindow: boolean;
}

/**
 * Inserts a single vote event row. The table has no UNIQUE constraints
 * because the same (user, play, direction) tuple can legitimately appear
 * multiple times across an add/remove/re-add sequence.
 */
export function insertVoteEvent(db: Database, evt: VoteEvent): void {
  db.prepare(`
    INSERT INTO votes (user_id, game_pk, play_index, direction, action, event_ts, received_at, post_window)
    VALUES ($userId, $gamePk, $playIndex, $direction, $action, $eventTs, datetime('now'), $postWindow);
  `).run({
    $userId: evt.userId,
    $gamePk: evt.gamePk,
    $playIndex: evt.playIndex,
    $direction: evt.direction,
    $action: evt.action,
    $eventTs: evt.eventTs,
    $postWindow: evt.postWindow ? 1 : 0,
  });
}

/** Reduced tally for a play, computed on read. */
export interface PlayTally {
  fire: number;
  trash: number;
  voters: Set<string>;
}

/**
 * Folds the event log for a play into a final tally.
 *
 * For each user, the final state per direction is the latest action
 * (added or removed). A user's vote contributes to fire and/or trash
 * if and only if the latest action for that direction was `added`.
 *
 * @param windowedOnly - When true, only events that arrived inside the
 *                       24h post window are counted. Late events are
 *                       persisted but excluded from the snapshot tally.
 */
export function computePlayTally(
  db: Database,
  gamePk: number,
  playIndex: number,
  windowedOnly = true,
): PlayTally {
  const sql = `
    SELECT user_id, direction, action FROM votes
    WHERE game_pk = $gamePk AND play_index = $playIndex
      ${windowedOnly ? "AND post_window = 0" : ""}
    ORDER BY id ASC;
  `;
  const rows = db.prepare(sql).all({ $gamePk: gamePk, $playIndex: playIndex }) as
    { user_id: string; direction: VoteDirection; action: VoteAction }[];

  const userState = new Map<string, { fire: boolean; trash: boolean }>();
  for (const r of rows) {
    const s = userState.get(r.user_id) ?? { fire: false, trash: false };
    s[r.direction] = r.action === "added";
    userState.set(r.user_id, s);
  }

  let fire = 0;
  let trash = 0;
  const voters = new Set<string>();
  for (const [user, state] of userState) {
    if (state.fire) {
      fire++;
      voters.add(user);
    }
    if (state.trash) {
      trash++;
      voters.add(user);
    }
  }
  return { fire, trash, voters };
}

/**
 * Returns true when the play's 24-hour post window has elapsed (so any
 * reactions arriving now are after-the-fact and won't count toward the
 * snapshot tally).
 *
 * Returns false when the play has no slack_play_messages row — without a
 * known `posted_at`, treat the event as in-window so the tally is at least
 * preserved if the row gets written later.
 */
export function isPostWindow(
  db: Database,
  gamePk: number,
  playIndex: number,
): boolean {
  const row = db.prepare(`
    SELECT (datetime(posted_at, '+24 hours') < datetime('now')) AS past
    FROM slack_play_messages
    WHERE game_pk = $gamePk AND play_index = $playIndex;
  `).get({ $gamePk: gamePk, $playIndex: playIndex }) as { past: number } | null;
  return row?.past === 1;
}
