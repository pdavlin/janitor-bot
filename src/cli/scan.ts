/**
 * CLI entry point for the janitor-bot outfield assist scanner.
 *
 * Ties together the shared pipeline, video matching, and SQLite storage
 * into a single scanning command.
 *
 * Usage:
 *   bun run src/cli/scan.ts                    # scan yesterday's games
 *   bun run src/cli/scan.ts --date 2025-06-15  # scan a specific date
 *   bun run src/cli/scan.ts --game 745433      # scan a single game
 *
 * Environment:
 *   DB_PATH - path to SQLite database file (default: ./janitor-throws.db)
 */

import {
  fetchLiveFeed,
  MlbApiError,
} from "../api/mlb-client";
import { detectOutfieldAssists } from "../detection/detect";
import type { DetectedPlay } from "../types/play";
import { matchVideoToPlay } from "../detection/video-match";
import { calculateTier } from "../detection/ranking";
import { fetchGameContent } from "../api/mlb-client";
import { createDatabase, insertPlays } from "../storage/db";
import { scanDate } from "../pipeline";
import { createLogger } from "../logger";

const logger = createLogger("info");

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  date: string | null;
  gamePk: number | null;
}

/**
 * Parse CLI arguments from Bun.argv.
 *
 * Supports:
 *   --date YYYY-MM-DD
 *   --game <gamePk>
 *
 * @returns Parsed arguments with date and gamePk fields.
 */
function parseArgs(): CliArgs {
  const args = Bun.argv.slice(2);
  const result: CliArgs = { date: null, gamePk: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--date" && next) {
      result.date = next;
      i++;
    } else if (arg === "--game" && next) {
      const parsed = parseInt(next, 10);
      if (Number.isNaN(parsed)) {
        console.error(`Invalid game ID: ${next}`);
        process.exit(1);
      }
      result.gamePk = parsed;
      i++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Returns yesterday's date as YYYY-MM-DD in local time.
 */
function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDate(d);
}

/**
 * Formats a Date object as YYYY-MM-DD.
 */
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Prints a single detected play to the console in a readable format.
 *
 * Format:
 *   [HIGH] CF Cody Bellinger - threw out runner at 3B
 *     CHC @ SD | 5th inning (top) | Score: 2-1
 *     "Bellinger throws out runner at third base"
 *     Video: https://...mp4
 */
function printPlay(play: DetectedPlay): void {
  const tierLabel = `[${play.tier.toUpperCase()}]`;
  const inningOrdinal = ordinal(play.inning);
  const halfLabel = play.halfInning === "top" ? "top" : "bottom";

  console.log(
    `${tierLabel} ${play.fielderPosition} ${play.fielderName} - threw out runner at ${play.targetBase}`
  );
  console.log(
    `  ${play.awayTeam} @ ${play.homeTeam} | ${inningOrdinal} inning (${halfLabel}) | Score: ${play.awayScore}-${play.homeScore}`
  );
  console.log(`  "${play.description}"`);

  if (play.videoUrl) {
    console.log(`  Video: ${play.videoUrl}`);
  }

  console.log("");
}

/**
 * Returns the ordinal suffix for an inning number (1st, 2nd, 3rd, 4th...).
 */
function ordinal(n: number): string {
  const suffixes: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };
  const remainder = n % 10;
  const teenCheck = n % 100;

  if (teenCheck >= 11 && teenCheck <= 13) {
    return `${n}th`;
  }

  return `${n}${suffixes[remainder] ?? "th"}`;
}

// ---------------------------------------------------------------------------
// Pipeline: single game by gamePk (--game flag)
// ---------------------------------------------------------------------------

/**
 * Scans a single game by gamePk. Fetches the live feed first to log
 * the matchup, then delegates to processGame for detection.
 *
 * The game date comes from --date if provided, otherwise extracted
 * from the live feed's gameData.datetime.officialDate field, with
 * today's date as a last-resort fallback.
 *
 * @param gamePk - MLB game identifier.
 * @param dateOverride - Optional date from the --date flag.
 * @returns Array of detected plays.
 */
async function scanSingleGame(
  gamePk: number,
  dateOverride: string | null
): Promise<DetectedPlay[]> {
  console.log(`Scanning game ${gamePk}...`);

  // Peek at the live feed for a matchup label before running detection.
  const liveFeed = await fetchLiveFeed(gamePk);
  const awayAbbr = liveFeed.gameData.teams.away.abbreviation;
  const homeAbbr = liveFeed.gameData.teams.home.abbreviation;
  console.log(`${awayAbbr} @ ${homeAbbr}\n`);

  const gameDate = dateOverride ?? liveFeed.gameData.datetime?.officialDate ?? formatDate(new Date());
  const plays = detectOutfieldAssists(liveFeed, gamePk, gameDate);

  if (plays.length === 0) {
    return [];
  }

  // Enrich with video URLs
  try {
    const content = await fetchGameContent(gamePk);

    for (const play of plays) {
      const match = matchVideoToPlay(content, {
        fielderId: play.fielderId,
        description: play.description,
      });

      if (match) {
        play.videoUrl = match.videoUrl;
        play.videoTitle = match.videoTitle;
      }
    }
  } catch (err) {
    logger.warn("could not fetch video content for game", {
      gamePk,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  for (const play of plays) {
    play.tier = calculateTier({
      targetBase: play.targetBase,
      creditChain: play.creditChain,
      hasVideo: play.videoUrl !== null,
    });
  }

  return plays;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const dbPath = process.env.DB_PATH ?? "./janitor-throws.db";

  let allPlays: DetectedPlay[];

  try {
    if (args.gamePk !== null) {
      allPlays = await scanSingleGame(args.gamePk, args.date);
    } else {
      const date = args.date ?? getYesterday();
      allPlays = await scanDate(date, logger);
    }
  } catch (err) {
    if (err instanceof MlbApiError) {
      console.error(`MLB API error (HTTP ${err.status}): ${err.message}`);
    } else {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    process.exit(1);
  }

  if (allPlays.length === 0) {
    console.log("No outfield assists found");
    return;
  }

  // Store results
  const db = createDatabase(dbPath);
  try {
    insertPlays(db, allPlays);
  } finally {
    db.close();
  }

  // Print results
  console.log("");
  for (const play of allPlays) {
    printPlay(play);
  }

  // Count unique games that had assists
  const uniqueGames = new Set(allPlays.map((p) => p.gamePk));
  console.log(
    `Found ${allPlays.length} outfield assist${allPlays.length === 1 ? "" : "s"} in ${uniqueGames.size} game${uniqueGames.size === 1 ? "" : "s"}`
  );
}

main();
