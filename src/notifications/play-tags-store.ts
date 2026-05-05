/**
 * Persistence helpers for the `play_tags` table.
 *
 * Tags are write-once records of operator comments parsed from Slack thread
 * replies. `playIndex` is nullable: a comment that does not unambiguously
 * mention a single fielder is attributed at the game level.
 */

import type { Database } from "bun:sqlite";
import type { TagType } from "./comment-tags";

export interface PlayTagInsert {
  gamePk: number;
  playIndex: number | null;
  tagType: TagType;
  tagValue: string;
  commentTs: string;
  commentUserId: string;
  matchedText: string;
}

export interface PlayTagRow {
  id: number;
  gamePk: number;
  playIndex: number | null;
  tagType: TagType;
  tagValue: string;
  commentTs: string;
  commentUserId: string;
  matchedText: string;
  receivedAt: string;
}

interface RawPlayTagRow {
  id: number;
  game_pk: number;
  play_index: number | null;
  tag_type: TagType;
  tag_value: string;
  comment_ts: string;
  comment_user_id: string;
  matched_text: string;
  received_at: string;
}

function rowToPlayTag(row: RawPlayTagRow): PlayTagRow {
  return {
    id: row.id,
    gamePk: row.game_pk,
    playIndex: row.play_index,
    tagType: row.tag_type,
    tagValue: row.tag_value,
    commentTs: row.comment_ts,
    commentUserId: row.comment_user_id,
    matchedText: row.matched_text,
    receivedAt: row.received_at,
  };
}

/**
 * Inserts a single play tag. Multiple tags from the same comment produce
 * multiple rows; the table has no uniqueness constraint, so duplicate calls
 * with the same arguments will append additional rows. Callers should rely on
 * the dispatcher's event_id dedupe upstream to prevent that.
 */
export function insertPlayTag(db: Database, tag: PlayTagInsert): void {
  db.prepare(`
    INSERT INTO play_tags (
      game_pk, play_index, tag_type, tag_value,
      comment_ts, comment_user_id, matched_text
    ) VALUES (
      $gamePk, $playIndex, $tagType, $tagValue,
      $commentTs, $commentUserId, $matchedText
    );
  `).run({
    $gamePk: tag.gamePk,
    $playIndex: tag.playIndex,
    $tagType: tag.tagType,
    $tagValue: tag.tagValue,
    $commentTs: tag.commentTs,
    $commentUserId: tag.commentUserId,
    $matchedText: tag.matchedText,
  });
}

/**
 * Returns every tag for a (gamePk, playIndex) pair. A null `playIndex`
 * fetches the game-level rows.
 */
export function queryPlayTags(
  db: Database,
  gamePk: number,
  playIndex: number | null,
): PlayTagRow[] {
  const sql = playIndex === null
    ? `SELECT * FROM play_tags WHERE game_pk = $gamePk AND play_index IS NULL ORDER BY received_at ASC;`
    : `SELECT * FROM play_tags WHERE game_pk = $gamePk AND play_index = $playIndex ORDER BY received_at ASC;`;

  const stmt = db.prepare(sql);
  const params: Record<string, number | null> = { $gamePk: gamePk };
  if (playIndex !== null) params.$playIndex = playIndex;
  const rows = stmt.all(params) as RawPlayTagRow[];
  return rows.map(rowToPlayTag);
}
