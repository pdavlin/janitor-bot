import type { Database } from "bun:sqlite";
import type { Tier } from "../../../types/play";

export interface QueryPlaysInWindowFilters {
  weekStarting: string;
  weekEnding: string;
  position?: string;
  targetBase?: string;
  runnersOn?: string;
  tier?: Tier;
  hasVideo?: boolean;
}

export interface PlayDetailsLite {
  playId: number;
  gamePk: number;
  playIndex: number;
  date: string;
  tier: Tier;
  position: string;
  targetBase: string;
  runnersOn: string;
  hasVideo: boolean;
}

export interface QueryPlaysInWindowResult {
  filters: QueryPlaysInWindowFilters;
  count: number;
  plays: PlayDetailsLite[];
}

const RESULT_CAP = 200;

/**
 * Filters plays inside a Sunday-Saturday window. All filters are
 * AND-combined. SQL is built dynamically but every value is
 * parameterized; never interpolated. Result is capped at 200 rows so
 * the agent can't fill the prompt with a single call.
 */
export function queryPlaysInWindow(
  db: Database,
  filters: QueryPlaysInWindowFilters,
): QueryPlaysInWindowResult {
  const conditions: string[] = ["date BETWEEN $from AND $to"];
  const params: Record<string, string | number> = {
    $from: filters.weekStarting,
    $to: filters.weekEnding,
  };

  if (filters.position !== undefined) {
    conditions.push("fielder_position = $position");
    params.$position = filters.position;
  }
  if (filters.targetBase !== undefined) {
    conditions.push("target_base = $targetBase");
    params.$targetBase = filters.targetBase;
  }
  if (filters.runnersOn !== undefined) {
    conditions.push("runners_on = $runnersOn");
    params.$runnersOn = filters.runnersOn;
  }
  if (filters.tier !== undefined) {
    conditions.push("tier = $tier");
    params.$tier = filters.tier;
  }
  if (filters.hasVideo === true) {
    conditions.push("video_url IS NOT NULL");
  } else if (filters.hasVideo === false) {
    conditions.push("video_url IS NULL");
  }

  const where = conditions.join(" AND ");
  const sql = `
    SELECT MIN(id) AS id, game_pk, play_index, date, fielder_position,
           target_base, runners_on, tier,
           MAX(CASE WHEN video_url IS NOT NULL THEN 1 ELSE 0 END) AS has_video
    FROM plays
    WHERE ${where}
    GROUP BY game_pk, play_index
    ORDER BY date ASC, game_pk ASC, play_index ASC
    LIMIT $limit;
  `;

  const rows = db.prepare(sql).all({ ...params, $limit: RESULT_CAP }) as {
    id: number;
    game_pk: number;
    play_index: number;
    date: string;
    fielder_position: string;
    target_base: string;
    runners_on: string;
    tier: Tier;
    has_video: number;
  }[];

  const plays: PlayDetailsLite[] = rows.map((r) => ({
    playId: r.id,
    gamePk: r.game_pk,
    playIndex: r.play_index,
    date: r.date,
    tier: r.tier,
    position: r.fielder_position,
    targetBase: r.target_base,
    runnersOn: r.runners_on,
    hasVideo: r.has_video === 1,
  }));

  return { filters, count: plays.length, plays };
}
