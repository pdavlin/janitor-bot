/**
 * Outfield assist detection from MLB live feed data.
 *
 * Scans every play in a game's live feed looking for runners thrown out
 * with an outfield assist credit ("f_assist_of"). Builds a DetectedPlay
 * record for each one, including the full credit chain.
 */

import type {
  LiveFeedResponse,
  Runner,
  RunnerCredit,
  Play,
  OutfieldPositionCode,
} from "../types/mlb-api";
import type { DetectedPlay } from "../types/play";

const OUTFIELD_CODES: ReadonlySet<string> = new Set<OutfieldPositionCode>([
  "7",
  "8",
  "9",
]);

/**
 * Play event types that should be excluded from outfield assist detection.
 *
 * These represent appeals, administrative changes, and other plays that
 * can carry assist credits but are not legitimate thrown-out-on-bases plays.
 */
const SKIP_EVENTS: ReadonlySet<string> = new Set([
  "Runner Out",
  "Game Advisory",
  "Pitching Substitution",
  "Defensive Sub",
  "Offensive Sub",
]);

/** Readable labels for base names returned by the API. */
const BASE_LABELS: Record<string, string> = {
  "1B": "1B",
  "2B": "2B",
  "3B": "3B",
  score: "Home",
  Home: "Home",
};

/** Display-friendly labels for base positions. */
const BASE_DISPLAY: Record<string, string> = {
  "1B": "1st",
  "2B": "2nd",
  "3B": "3rd",
};

/**
 * Format runner positions into a display string like "1st, 3rd".
 * Returns empty string if no runners are on base.
 */
export function formatRunnersOn(runners: Runner[]): string {
  const bases = [
    ...new Set(
      runners
        .map((r) => r.movement.originBase)
        .filter((b): b is string => b !== null && b in BASE_DISPLAY)
    ),
  ].sort((a, b) => ["1B", "2B", "3B"].indexOf(a) - ["1B", "2B", "3B"].indexOf(b));

  return bases.map((b) => BASE_DISPLAY[b]).join(", ");
}

export type { DetectedPlay } from "../types/play";

/**
 * Look up a player's full name from the gameData.players map.
 *
 * The API keys players as "ID{id}", e.g. "ID676962".
 *
 * @param players - The gameData.players record from the live feed.
 * @param playerId - Numeric player ID.
 * @returns The player's full name, or "Unknown" if not found.
 */
function resolvePlayerName(
  players: LiveFeedResponse["gameData"]["players"],
  playerId: number,
): string {
  const entry = players[`ID${playerId}`];
  return entry?.fullName ?? "Unknown";
}

/**
 * Normalize the API's outBase value into a display-friendly base label.
 *
 * The API sometimes uses "score" instead of "Home" for plays at the plate.
 *
 * @param outBase - Raw outBase string from runner movement.
 * @returns Normalized label like "2B", "3B", or "Home".
 */
function normalizeBase(outBase: string | null): string {
  if (!outBase) return "Unknown";
  return BASE_LABELS[outBase] ?? outBase;
}

/**
 * Build a human-readable credit chain from a runner's credit list.
 *
 * Joins position abbreviations in order with " -> ", e.g. "RF -> 2B -> C".
 *
 * @param credits - The credits array from a Runner record.
 * @returns Formatted chain string.
 */
function buildCreditChain(credits: RunnerCredit[]): string {
  return credits
    .map((c) => c.position.abbreviation)
    .filter((pos, i, arr) => i === 0 || pos !== arr[i - 1])
    .join(" -> ");
}

/**
 * Find the outfield assist credit in a runner's credit list, if any.
 *
 * Checks for credit type "f_assist_of" with a position code in {7, 8, 9}.
 *
 * @param credits - The credits array from a Runner record.
 * @returns The matching credit, or undefined.
 */
function findOutfieldAssistCredit(
  credits: RunnerCredit[],
): RunnerCredit | undefined {
  return credits.find(
    (c) => c.credit === "f_assist_of" && OUTFIELD_CODES.has(c.position.code),
  );
}

/**
 * Scan a live feed response for outfield assists and return structured records.
 *
 * For each play and each runner within that play, checks whether:
 *   1. The runner was called out (movement.isOut === true)
 *   2. Any credit on the runner is "f_assist_of" from an outfield position
 *
 * @param liveFeed - Full live feed response for a game.
 * @param gamePk - The game's unique identifier.
 * @param gameDate - Date string formatted as YYYY-MM-DD.
 * @returns Array of detected outfield assist plays, possibly empty.
 */
export function detectOutfieldAssists(
  liveFeed: LiveFeedResponse,
  gamePk: number,
  gameDate: string,
): DetectedPlay[] {
  const { gameData, liveData } = liveFeed;
  const awayTeam = gameData.teams.away.abbreviation;
  const homeTeam = gameData.teams.home.abbreviation;
  const players = gameData.players;

  const detected: DetectedPlay[] = [];

  for (const play of liveData.plays.allPlays) {
    // Skip appeal plays and other non-throw events
    if (SKIP_EVENTS.has(play.result.event)) continue;

    for (const runner of play.runners) {
      if (!runner.movement.isOut) continue;

      // A null outBase on an isOut runner is suspicious data; skip it.
      if (!runner.movement.outBase) continue;

      const assistCredit = findOutfieldAssistCredit(runner.credits ?? []);
      if (!assistCredit) continue;

      const targetBase = normalizeBase(runner.movement.outBase);
      const creditChain = buildCreditChain(runner.credits ?? []);
      const outs = play.count?.outs ?? 0;
      const runnersOn = formatRunnersOn(play.runners);

      detected.push({
        gamePk,
        playIndex: play.about.atBatIndex,
        date: gameDate,
        fielderId: assistCredit.player.id,
        fielderName: resolvePlayerName(players, assistCredit.player.id),
        fielderPosition: assistCredit.position.abbreviation,
        runnerId: runner.details.runner.id,
        runnerName: runner.details.runner.fullName,
        targetBase,
        batterName: play.matchup.batter.fullName,
        inning: play.about.inning,
        halfInning: play.about.halfInning,
        awayScore: play.result.awayScore,
        homeScore: play.result.homeScore,
        awayTeam,
        homeTeam,
        description: play.result.description,
        creditChain,
        tier: "low",
        outs,
        runnersOn,
        videoUrl: null,
        videoTitle: null,
      });
    }
  }

  return detected;
}
