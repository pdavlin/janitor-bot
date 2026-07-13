/**
 * Background Savant video backfill cycle.
 *
 * Walks plays that don't yet have a video URL but do have a playId, retries
 * the Savant fetch, and writes the outcome back. Runs as a peer task to the
 * main game scheduler at a fixed interval.
 *
 * Phase 2 of the savant-video-backfill rollout.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../logger";
import {
  queryBackfillCandidates,
  queryVelocityBackfillCandidates,
  updatePlayVideoByPlayKey,
  updatePlayFetchStatus,
  updatePlayThrowVelocity,
} from "../storage/db";
import { fetchSavantVideo } from "../detection/savant-video";
import { resolveThrowVelocity, clearThrowCache } from "../detection/arm-velocity";

/** Aggregate counters for a single backfill cycle. Returned for logging. */
export interface BackfillStats {
  attempted: number;
  succeeded: number;
  stillPending: number;
  agedOut: number;
}

/** Payload passed to the optional onSuccess callback when a play gets video. */
export interface BackfillSuccessEvent {
  gamePk: number;
  playIndex: number;
  videoUrl: string;
  videoTitle: string;
}

/** Pause between Savant requests inside a cycle to keep the rate sane. */
const INTER_FETCH_SLEEP_MS = 250;

/**
 * Runs one backfill pass. Sequentially probes every eligible candidate,
 * writes the result, and returns aggregate stats.
 *
 * @param db - Open database.
 * @param logger - Structured logger.
 * @param options.windowDays - Inclusive age cutoff in days. Defaults to 2.
 * @param options.onSuccess - Optional hook fired once per successful row group.
 *                            Reserved for Phase 3's Slack notification.
 * @param options.isShuttingDown - Optional thunk; when it returns true the
 *                                 cycle aborts before the next candidate.
 */
export async function runBackfillCycle(
  db: Database,
  logger: Logger,
  options: {
    windowDays?: number;
    onSuccess?: (event: BackfillSuccessEvent) => Promise<void> | void;
    isShuttingDown?: () => boolean;
  } = {},
): Promise<BackfillStats> {
  const { windowDays = 2, onSuccess, isShuttingDown } = options;
  const candidates = queryBackfillCandidates(db, windowDays);
  const stats: BackfillStats = {
    attempted: 0,
    succeeded: 0,
    stillPending: 0,
    agedOut: 0,
  };

  logger.info("backfill cycle starting", { candidates: candidates.length });

  for (const candidate of candidates) {
    if (isShuttingDown?.()) {
      logger.info("backfill cycle aborted by shutdown");
      break;
    }
    stats.attempted++;
    const result = await fetchSavantVideo(candidate.playId, logger);
    if (result.status === "success") {
      updatePlayVideoByPlayKey(
        db,
        candidate.gamePk,
        candidate.playIndex,
        result.videoUrl,
        result.videoTitle,
      );
      stats.succeeded++;
      if (onSuccess) {
        await onSuccess({
          gamePk: candidate.gamePk,
          playIndex: candidate.playIndex,
          videoUrl: result.videoUrl,
          videoTitle: result.videoTitle,
        });
      }
    } else {
      updatePlayFetchStatus(
        db,
        candidate.gamePk,
        candidate.playIndex,
        result.status,
      );
      stats.stillPending++;
    }
    await Bun.sleep(INTER_FETCH_SLEEP_MS);
  }

  logger.info("backfill cycle complete", { ...stats });
  return stats;
}

/** Aggregate counters for a single velocity backfill cycle. */
export interface VelocityBackfillStats {
  attempted: number;
  matched: number;
  stillUnmatched: number;
  errors: number;
}

/**
 * Runs one throw-velocity backfill pass.
 *
 * Savant's arm-strength leaderboard is populated by a batch that lags game
 * end, so the pipeline's lookup at game-Final time systematically returns
 * no_match. This cycle re-resolves velocity for recent plays whose status
 * is not yet 'matched' — including prior 'no_match' rows — until they age
 * out of the window, mirroring the video cycle's retry of 'no_video_found'.
 *
 * @param db - Open database.
 * @param logger - Structured logger.
 * @param options.windowDays - Inclusive age cutoff in days. Defaults to 2.
 * @param options.isShuttingDown - Optional thunk; when it returns true the
 *                                 cycle aborts before the next candidate.
 */
export async function runVelocityBackfillCycle(
  db: Database,
  logger: Logger,
  options: {
    windowDays?: number;
    isShuttingDown?: () => boolean;
  } = {},
): Promise<VelocityBackfillStats> {
  const { windowDays = 2, isShuttingDown } = options;

  // The arm-velocity module caches (fielder, year) responses for the
  // process lifetime. A long-lived daemon would otherwise keep re-checking
  // the stale game-night snapshot, so drop the cache before each cycle.
  clearThrowCache();

  const candidates = queryVelocityBackfillCandidates(db, windowDays);
  const stats: VelocityBackfillStats = {
    attempted: 0,
    matched: 0,
    stillUnmatched: 0,
    errors: 0,
  };

  logger.info("velocity backfill cycle starting", {
    candidates: candidates.length,
  });

  for (const candidate of candidates) {
    if (isShuttingDown?.()) {
      logger.info("velocity backfill cycle aborted by shutdown");
      break;
    }
    stats.attempted++;
    const year = Number(candidate.date.slice(0, 4));
    const result = await resolveThrowVelocity(
      candidate.fielderId,
      year,
      candidate.playId,
      logger,
    );
    if (result.status === "matched") {
      updatePlayThrowVelocity(
        db,
        candidate.gamePk,
        candidate.playIndex,
        result.velocityMph,
        "matched",
      );
      stats.matched++;
    } else if (result.status === "no_match") {
      updatePlayThrowVelocity(
        db,
        candidate.gamePk,
        candidate.playIndex,
        null,
        "no_match",
      );
      stats.stillUnmatched++;
    } else {
      // Fetch error: record the status; the row stays eligible for retry.
      updatePlayThrowVelocity(
        db,
        candidate.gamePk,
        candidate.playIndex,
        null,
        result.status,
      );
      stats.errors++;
    }
    await Bun.sleep(INTER_FETCH_SLEEP_MS);
  }

  logger.info("velocity backfill cycle complete", { ...stats });
  return stats;
}
