/**
 * Shared detection pipeline used by both the CLI scanner and the daemon scheduler.
 *
 * Extracts the core scanning logic so callers only need to provide a gamePk/date
 * and a Logger. The pipeline handles: live feed fetch, outfield assist detection,
 * video matching, and schedule-based batch scanning.
 */

import {
  fetchSchedule,
  fetchLiveFeed,
  fetchGameContent,
  getCompletedGames,
} from "./api/mlb-client";
import { detectOutfieldAssists } from "./detection/detect";
import type { DetectedPlay } from "./types/play";
import { matchVideoToPlay } from "./detection/video-match";
import { extractPlayId, fetchSavantVideo } from "./detection/savant-video";
import { calculateTier } from "./detection/ranking";
import type { Logger } from "./logger";

export type { DetectedPlay } from "./types/play";

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the YYYY-MM-DD portion from an ISO 8601 date-time string.
 *
 * @param isoDate - e.g. "2025-06-15T23:10:00Z"
 * @returns Date portion, e.g. "2025-06-15"
 */
export function extractGameDate(isoDate: string): string {
  return isoDate.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Pipeline: process a single game
// ---------------------------------------------------------------------------

/**
 * Runs the full detection pipeline for a single game: fetch live feed,
 * detect outfield assists, match videos, and return enriched plays.
 *
 * Video matching is best-effort. A content fetch failure logs a warning
 * but still returns the detected plays without video URLs.
 *
 * @param gamePk - MLB game identifier.
 * @param gameDate - Game date as YYYY-MM-DD.
 * @param logger - Structured logger for diagnostics.
 * @returns Array of detected plays with video URLs populated where matched.
 */
export async function processGame(
  gamePk: number,
  gameDate: string,
  logger: Logger,
): Promise<DetectedPlay[]> {
  const liveFeed = await fetchLiveFeed(gamePk);
  const officialDate = liveFeed.gameData.datetime?.officialDate ?? gameDate;
  const plays = detectOutfieldAssists(liveFeed, gamePk, officialDate);

  if (plays.length === 0) {
    return [];
  }

  // Savant video matching (primary source) - fetches are independent, run in parallel
  await Promise.all(
    plays.map(async (play) => {
      const liveFeedPlay = liveFeed.liveData.plays.allPlays.find(
        (p) => p.about.atBatIndex === play.playIndex
      );
      const playId = extractPlayId(liveFeedPlay?.playEvents);
      play.playId = playId;

      if (!playId) {
        play.fetchStatus = "no_play_id";
        return;
      }

      const result = await fetchSavantVideo(playId, logger);
      play.fetchStatus = result.status;
      if (result.status === "success") {
        play.videoUrl = result.videoUrl;
        play.videoTitle = result.videoTitle;
      } else {
        logger.debug("savant fetch non-success", {
          playId,
          gamePk,
          playIndex: play.playIndex,
          status: result.status,
        });
      }
    })
  );

  // Content API fallback for plays still missing video
  const playsNeedingVideo = plays.filter((p) => !p.videoUrl);
  if (playsNeedingVideo.length > 0) {
    try {
      const content = await fetchGameContent(gamePk);

      for (const play of playsNeedingVideo) {
        const match = matchVideoToPlay(content, {
          fielderId: play.fielderId,
          description: play.description,
        });

        if (match) {
          play.videoUrl = match.videoUrl;
          play.videoTitle = match.videoTitle;
          play.fetchStatus = "success";
        }
      }
    } catch (err) {
      logger.warn("could not fetch video content for game", {
        gamePk,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const play of plays) {
    play.tier = calculateTier({
      targetBase: play.targetBase,
      creditChain: play.creditChain,
      hasVideo: play.videoUrl !== null,
      isOverturned: play.isOverturned,
    });
  }

  return plays;
}

// ---------------------------------------------------------------------------
// Pipeline: scan all completed games for a date
// ---------------------------------------------------------------------------

/**
 * Scans all completed games for a given date and returns detected plays.
 *
 * Fetches the schedule, filters to completed games, then runs processGame
 * on each one. Individual game failures are logged and skipped so a single
 * broken game does not prevent processing the rest.
 *
 * @param date - Date string as YYYY-MM-DD.
 * @param logger - Structured logger for diagnostics.
 * @returns All detected plays across all completed games for that date.
 */
export async function scanDate(
  date: string,
  logger: Logger,
): Promise<DetectedPlay[]> {
  logger.info("scanning games for date", { date });

  const schedule = await fetchSchedule(date);
  const completedGames = getCompletedGames(schedule);

  if (completedGames.length === 0) {
    logger.info("no completed games found", { date });
    return [];
  }

  logger.info("found completed games", { date, count: completedGames.length });

  const allPlays: DetectedPlay[] = [];

  for (const game of completedGames) {
    const gameDate = extractGameDate(game.gameDate);
    try {
      const plays = await processGame(game.gamePk, gameDate, logger);
      allPlays.push(...plays);
    } catch (err) {
      const label = `${game.teams.away.team.name} @ ${game.teams.home.team.name}`;
      logger.error("error processing game", {
        gamePk: game.gamePk,
        matchup: label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return allPlays;
}
