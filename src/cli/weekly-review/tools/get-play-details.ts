import type { Database } from "bun:sqlite";
import type { FetchStatus, Tier } from "../../../types/play";

export interface PlayDetailsResult {
  playId: number;
  date: string;
  tier: Tier;
  position: string;
  targetBase: string;
  runnersOn: string;
  creditChain: string;
  hasVideo: boolean;
  fetchStatus: FetchStatus | null;
  awayTeam: string;
  homeTeam: string;
  inning: number;
  halfInning: string;
  outs: number;
  gamePk: number;
  playIndex: number;
}

/**
 * Returns the metadata fields the agent needs to verify hypotheses
 * about a single play. `hasVideo` is a boolean derived from
 * `video_url`; the URL itself is intentionally omitted to save tokens
 * and avoid surfacing URLs unnecessarily.
 */
export function getPlayDetails(
  db: Database,
  playId: number,
): PlayDetailsResult | { error: "not_found" } {
  const row = db
    .prepare(
      `SELECT id, game_pk, play_index, date, tier, fielder_position,
              target_base, runners_on, credit_chain, video_url, fetch_status,
              away_team, home_team, inning, half_inning, outs
       FROM plays
       WHERE id = $playId
       LIMIT 1;`,
    )
    .get({ $playId: playId }) as
    | {
        id: number;
        game_pk: number;
        play_index: number;
        date: string;
        tier: Tier;
        fielder_position: string;
        target_base: string;
        runners_on: string;
        credit_chain: string;
        video_url: string | null;
        fetch_status: FetchStatus | null;
        away_team: string;
        home_team: string;
        inning: number;
        half_inning: string;
        outs: number;
      }
    | null;
  if (!row) return { error: "not_found" };
  return {
    playId: row.id,
    date: row.date,
    tier: row.tier,
    position: row.fielder_position,
    targetBase: row.target_base,
    runnersOn: row.runners_on,
    creditChain: row.credit_chain,
    hasVideo: row.video_url !== null,
    fetchStatus: row.fetch_status,
    awayTeam: row.away_team,
    homeTeam: row.home_team,
    inning: row.inning,
    halfInning: row.half_inning,
    outs: row.outs,
    gamePk: row.game_pk,
    playIndex: row.play_index,
  };
}
