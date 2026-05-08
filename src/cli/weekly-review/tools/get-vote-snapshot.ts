import type { Database } from "bun:sqlite";

export interface VoteSnapshotResult {
  playId: number;
  gamePk: number;
  playIndex: number;
  fireCount: number;
  trashCount: number;
  voterCount: number;
  netScore: number;
}

/**
 * Returns recorded fire/trash/voter counts for a play. When the play
 * exists but has no `vote_snapshots` row (only past-24h plays get a
 * snapshot) the counts are 0 — that is itself informative ("no
 * recorded votes" rather than "no data").
 */
export function getVoteSnapshot(
  db: Database,
  playId: number,
): VoteSnapshotResult | { error: "not_found" } {
  const row = db
    .prepare(
      `SELECT p.id AS play_id, p.game_pk, p.play_index,
              s.fire_count, s.trash_count, s.voter_count, s.net_score
       FROM plays p
       LEFT JOIN vote_snapshots s
         ON s.game_pk = p.game_pk AND s.play_index = p.play_index
       WHERE p.id = $playId
       LIMIT 1;`,
    )
    .get({ $playId: playId }) as
    | {
        play_id: number;
        game_pk: number;
        play_index: number;
        fire_count: number | null;
        trash_count: number | null;
        voter_count: number | null;
        net_score: number | null;
      }
    | null;
  if (!row) return { error: "not_found" };
  return {
    playId: row.play_id,
    gamePk: row.game_pk,
    playIndex: row.play_index,
    fireCount: row.fire_count ?? 0,
    trashCount: row.trash_count ?? 0,
    voterCount: row.voter_count ?? 0,
    netScore: row.net_score ?? 0,
  };
}
