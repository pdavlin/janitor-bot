import type { Database } from "bun:sqlite";
import type { TagType } from "../../../notifications/comment-tags";

export interface PlayTag {
  tagType: TagType;
  tagValue: string;
}

export interface PlayTagsForPlayResult {
  playId: number;
  tags: PlayTag[];
}

/**
 * Returns phase 3 regex tags attached to a play. Selects only
 * `tag_type` and `tag_value`; `matched_text` is intentionally omitted
 * to avoid surfacing user-typed prose to the agent (FR-1.11).
 *
 * `play_tags.play_index` is NULLABLE — game-level tags also apply to
 * every play in the game. The lookup honors that.
 */
export function getPlayTagsForPlay(
  db: Database,
  playId: number,
): PlayTagsForPlayResult | { error: "not_found" } {
  const playRow = db
    .prepare(
      `SELECT id, game_pk, play_index FROM plays WHERE id = $playId LIMIT 1;`,
    )
    .get({ $playId: playId }) as
    | { id: number; game_pk: number; play_index: number }
    | null;
  if (!playRow) return { error: "not_found" };

  let tagRows: { tag_type: TagType; tag_value: string }[];
  try {
    tagRows = db
      .prepare(
        `SELECT tag_type, tag_value
         FROM play_tags
         WHERE game_pk = $gamePk
           AND (play_index IS NULL OR play_index = $playIndex)
         ORDER BY id ASC;`,
      )
      .all({
        $gamePk: playRow.game_pk,
        $playIndex: playRow.play_index,
      }) as { tag_type: TagType; tag_value: string }[];
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table: play_tags")) {
      tagRows = [];
    } else {
      throw err;
    }
  }

  return {
    playId: playRow.id,
    tags: tagRows.map((r) => ({ tagType: r.tag_type, tagValue: r.tag_value })),
  };
}
