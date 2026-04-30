/**
 * Self-scheduling daemon that polls MLB games and runs the outfield assist
 * detection pipeline when games reach their final state.
 *
 * Lifecycle:
 *   1. Fetch today's schedule on startup.
 *   2. If no games, sleep until tomorrow's first game minus 30 minutes.
 *   3. Track each game independently through: pending -> live -> final | abandoned.
 *   4. Poll at POLL_INTERVAL_MINUTES for state changes.
 *   5. When a game reaches Final, run detection, store results, notify Slack.
 *   6. After all games for the day resolve, advance to the next day.
 *
 * Graceful shutdown: call requestShutdown() to finish the current scan
 * and exit the loop without starting new work.
 */

import { fetchSchedule } from "../api/mlb-client";
import type { ScheduleGame } from "../types/mlb-api";
import { processGame, extractGameDate, scanDate } from "../pipeline";
import { insertPlays } from "../storage/db";
import { sendSlackNotifications, filterByMinTier } from "../notifications/slack";
import { runBackfillCycle } from "./backfill";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Database } from "bun:sqlite";
import type { DetectedPlay } from "../types/play";

// ---------------------------------------------------------------------------
// Game state tracking
// ---------------------------------------------------------------------------

/** Possible states for a tracked game in the scheduler. */
type GameTrackingState = "pending" | "live" | "final" | "abandoned";

/**
 * Internal tracking record for a single game.
 * The scheduler maintains one of these per gamePk for the current day.
 */
interface TrackedGame {
  gamePk: number;
  scheduledStart: Date;
  /** Raw gameDate from the schedule API (ISO 8601). Used to derive YYYY-MM-DD
   *  for the detection pipeline without UTC/local timezone conversion issues. */
  gameDate: string;
  state: GameTrackingState;
  awayTeam: string;
  homeTeam: string;
}

// ---------------------------------------------------------------------------
// Scheduler status (shared with HTTP server)
// ---------------------------------------------------------------------------

/** Snapshot of the scheduler's current state, exposed to the HTTP server. */
export interface SchedulerStatus {
  gamesTracked: number;
  gamesLive: number;
  gamesFinal: number;
  gamesAbandoned: number;
  currentDate: string;
  lastPollTime: string | null;
}

let currentStatus: SchedulerStatus = {
  gamesTracked: 0,
  gamesLive: 0,
  gamesFinal: 0,
  gamesAbandoned: 0,
  currentDate: "",
  lastPollTime: null,
};

/**
 * Returns a shallow copy of the current scheduler status.
 * Used by the HTTP server to serve the /status endpoint.
 */
export function getSchedulerStatus(): SchedulerStatus {
  return { ...currentStatus };
}

/**
 * Recomputes the module-level status from the current tracked games array.
 *
 * @param tracked - Current set of tracked games for the day
 * @param date - The YYYY-MM-DD date string for the current schedule day
 */
function updateStatus(tracked: TrackedGame[], date: string): void {
  currentStatus = {
    gamesTracked: tracked.length,
    gamesLive: tracked.filter((g) => g.state === "live").length,
    gamesFinal: tracked.filter((g) => g.state === "final").length,
    gamesAbandoned: tracked.filter((g) => g.state === "abandoned").length,
    currentDate: date,
    lastPollTime: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Shutdown coordination
// ---------------------------------------------------------------------------

let shutdownRequested = false;

/**
 * Signals the scheduler to stop after completing any in-progress work.
 * The scheduler checks this flag between polls and before starting new scans.
 */
export function requestShutdown(): void {
  shutdownRequested = true;
}

/** Resets the shutdown flag. Useful for tests. */
export function resetShutdown(): void {
  shutdownRequested = false;
}

/**
 * Returns the current value of the shutdown flag. Provided for callers
 * that need a thunk (e.g. the backfill loop's isShuttingDown hook).
 */
function isShuttingDown(): boolean {
  return shutdownRequested;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Formats a Date as YYYY-MM-DD in local time.
 */
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Returns today's date as YYYY-MM-DD in local time.
 */
function getTodayDate(): string {
  return formatDate(new Date());
}

/**
 * Returns tomorrow's date as YYYY-MM-DD in local time.
 */
function getTomorrowDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return formatDate(d);
}

/** Six hours in milliseconds. Games not Final after this are abandoned. */
const ABANDON_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** Thirty minutes in milliseconds. Pre-game buffer for schedule fetching. */
const PRE_GAME_BUFFER_MS = 30 * 60 * 1000;

/** Minimum sleep between schedule checks when no games exist (5 minutes). */
const MIN_SLEEP_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Core scheduler
// ---------------------------------------------------------------------------

interface SchedulerOptions {
  config: Config;
  db: Database;
  logger: Logger;
}

/**
 * Builds a TrackedGame from a schedule API game entry.
 */
function toTrackedGame(game: ScheduleGame): TrackedGame {
  const state: GameTrackingState =
    game.status.abstractGameState === "Final"
      ? "final"
      : game.status.abstractGameState === "Live"
        ? "live"
        : "pending";

  return {
    gamePk: game.gamePk,
    scheduledStart: new Date(game.gameDate),
    gameDate: game.gameDate,
    state,
    awayTeam: game.teams.away.team.name,
    homeTeam: game.teams.home.team.name,
  };
}

/**
 * Calculates how long to sleep before the next meaningful event.
 *
 * If there are pending/live games, sleep for the poll interval.
 * If all games are resolved (final/abandoned), return 0 to advance the day.
 *
 * @param tracked - Current set of tracked games
 * @param pollIntervalMs - Poll interval in milliseconds
 * @returns Milliseconds to sleep
 */
function calculateSleepMs(
  tracked: TrackedGame[],
  pollIntervalMs: number,
): number {
  const activeGames = tracked.filter(
    (g) => g.state === "pending" || g.state === "live",
  );

  if (activeGames.length === 0) {
    return 0;
  }

  return pollIntervalMs;
}

/**
 * Runs the detection pipeline for a game that just reached Final,
 * stores results, and sends Slack notifications if configured.
 *
 * @param game - The tracked game record
 * @param options - Scheduler options (config, db, logger)
 * @returns Number of plays detected
 */
async function handleFinalGame(
  game: TrackedGame,
  options: SchedulerOptions,
): Promise<number> {
  const { config, db, logger } = options;
  const gameDate = extractGameDate(game.gameDate);
  const label = `${game.awayTeam} @ ${game.homeTeam}`;

  logger.info("game reached final, running detection", {
    gamePk: game.gamePk,
    matchup: label,
  });

  let plays: DetectedPlay[];
  try {
    plays = await processGame(game.gamePk, gameDate, logger);
  } catch (err) {
    logger.error("detection pipeline failed", {
      gamePk: game.gamePk,
      matchup: label,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  if (plays.length === 0) {
    logger.info("no outfield assists detected", {
      gamePk: game.gamePk,
      matchup: label,
    });
    return 0;
  }

  logger.info("outfield assists detected", {
    gamePk: game.gamePk,
    matchup: label,
    count: plays.length,
  });

  // Store in database
  try {
    insertPlays(db, plays);
    logger.info("plays stored in database", {
      gamePk: game.gamePk,
      count: plays.length,
    });
  } catch (err) {
    logger.error("failed to store plays", {
      gamePk: game.gamePk,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Send Slack notifications if configured
  if (config.slackWebhookUrl) {
    const filtered = filterByMinTier(plays, config.minTier);
    if (filtered.length > 0) {
      try {
        const sent = await sendSlackNotifications(
          filtered,
          config.slackWebhookUrl,
          logger,
        );
        logger.info("slack notifications sent", {
          gamePk: game.gamePk,
          messagesSent: sent,
        });
      } catch (err) {
        logger.error("slack notification error", {
          gamePk: game.gamePk,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return plays.length;
}

/**
 * Updates tracked game states by re-fetching the schedule and comparing
 * against current tracking records.
 *
 * State transitions:
 *   pending -> live    (abstractGameState changed to "Live")
 *   pending -> final   (abstractGameState changed to "Final")
 *   live    -> final   (abstractGameState changed to "Final")
 *   pending -> abandoned (6+ hours past scheduled start, never reached Final)
 *   live    -> abandoned (6+ hours past scheduled start, never reached Final)
 *
 * @param tracked - Mutable array of tracked games to update in place
 * @param date - The date string to re-fetch the schedule for
 * @param options - Scheduler options
 */
async function updateGameStates(
  tracked: TrackedGame[],
  date: string,
  options: SchedulerOptions,
): Promise<void> {
  const { logger } = options;
  const now = Date.now();

  let schedule;
  try {
    schedule = await fetchSchedule(date);
  } catch (err) {
    logger.error("failed to fetch schedule for state update", {
      date,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Build a lookup from the fresh schedule data
  const freshGames = new Map<number, ScheduleGame>();
  for (const dateEntry of schedule.dates) {
    for (const game of dateEntry.games) {
      freshGames.set(game.gamePk, game);
    }
  }

  for (const tracked_game of tracked) {
    // Skip games already in a terminal state
    if (tracked_game.state === "final" || tracked_game.state === "abandoned") {
      continue;
    }

    const fresh = freshGames.get(tracked_game.gamePk);
    if (!fresh) {
      // Game disappeared from schedule -- could be postponed entirely
      const elapsed = now - tracked_game.scheduledStart.getTime();
      if (elapsed > ABANDON_THRESHOLD_MS) {
        logger.warn("game disappeared from schedule, marking abandoned", {
          gamePk: tracked_game.gamePk,
          matchup: `${tracked_game.awayTeam} @ ${tracked_game.homeTeam}`,
        });
        tracked_game.state = "abandoned";
      }
      continue;
    }

    const newAbstractState = fresh.status.abstractGameState;
    // Save previous state for logging before any mutation.
    // At this point state is narrowed to "pending" | "live" since
    // terminal states are skipped above.
    const previousState: GameTrackingState = tracked_game.state;

    if (newAbstractState === "Final") {
      tracked_game.state = "final";
      logger.info("game state transition", {
        gamePk: tracked_game.gamePk,
        from: previousState,
        to: "final",
        matchup: `${tracked_game.awayTeam} @ ${tracked_game.homeTeam}`,
      });
      await handleFinalGame(tracked_game, options);
      continue;
    }

    if (newAbstractState === "Live" && previousState === "pending") {
      tracked_game.state = "live";
      logger.info("game state transition", {
        gamePk: tracked_game.gamePk,
        from: "pending",
        to: "live",
        matchup: `${tracked_game.awayTeam} @ ${tracked_game.homeTeam}`,
      });
    }

    // Check abandonment for games that have been going too long.
    // tracked_game.state is "pending" or "live" here (we continue'd on final).
    const elapsed = now - tracked_game.scheduledStart.getTime();
    if (elapsed > ABANDON_THRESHOLD_MS) {
      logger.warn("game exceeded abandon threshold, marking abandoned", {
        gamePk: tracked_game.gamePk,
        matchup: `${tracked_game.awayTeam} @ ${tracked_game.homeTeam}`,
        elapsedHours: (elapsed / (60 * 60 * 1000)).toFixed(1),
      });
      tracked_game.state = "abandoned";
    }
  }
}

/**
 * Fetches the schedule for a date and returns the initial set of tracked games.
 *
 * Games already in Final state are immediately processed through the detection
 * pipeline (covers the case where the daemon starts after games have ended).
 *
 * @param date - Date as YYYY-MM-DD
 * @param options - Scheduler options
 * @returns Array of tracked games for the date
 */
async function initializeDaySchedule(
  date: string,
  options: SchedulerOptions,
): Promise<TrackedGame[]> {
  const { logger } = options;

  logger.info("fetching schedule", { date });

  const schedule = await fetchSchedule(date);
  const allGames: ScheduleGame[] = schedule.dates.flatMap((d) => d.games);

  if (allGames.length === 0) {
    logger.info("no games scheduled", { date });
    return [];
  }

  logger.info("games found on schedule", { date, count: allGames.length });

  const tracked: TrackedGame[] = allGames.map(toTrackedGame);

  // Log each game being tracked
  for (const game of tracked) {
    logger.debug("tracking game", {
      gamePk: game.gamePk,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      scheduledStart: game.scheduledStart.toISOString(),
      state: game.state,
    });
  }

  // Process any games that are already Final (daemon started late)
  const alreadyFinal = tracked.filter((g) => g.state === "final");
  for (const game of alreadyFinal) {
    await handleFinalGame(game, options);
    if (shutdownRequested) break;
  }

  return tracked;
}

/**
 * Calculates how long to sleep until the next day's first game,
 * with a 30-minute buffer before the earliest scheduled start.
 *
 * Falls back to sleeping until midnight + 30 minutes if the schedule
 * is empty or the API call fails.
 *
 * @param logger - Logger for diagnostics
 * @returns Milliseconds to sleep
 */
async function sleepUntilNextDay(logger: Logger): Promise<number> {
  const tomorrow = getTomorrowDate();

  try {
    const schedule = await fetchSchedule(tomorrow);
    const allGames = schedule.dates.flatMap((d) => d.games);

    if (allGames.length > 0) {
      const startTimes = allGames.map((g) => new Date(g.gameDate).getTime());
      const earliest = Math.min(...startTimes);
      const wakeUpAt = earliest - PRE_GAME_BUFFER_MS;
      const sleepMs = Math.max(wakeUpAt - Date.now(), MIN_SLEEP_MS);

      logger.info("sleeping until next day games", {
        tomorrow,
        gameCount: allGames.length,
        wakeUpAt: new Date(wakeUpAt).toISOString(),
        sleepMinutes: Math.round(sleepMs / 60000),
      });

      return sleepMs;
    }
  } catch (err) {
    logger.warn("could not fetch tomorrow schedule for sleep calculation", {
      date: tomorrow,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback: sleep until midnight + 30 minutes
  const midnightTomorrow = new Date(tomorrow + "T00:00:00");
  const fallbackMs = Math.max(
    midnightTomorrow.getTime() + PRE_GAME_BUFFER_MS - Date.now(),
    MIN_SLEEP_MS,
  );

  logger.info("no games found for tomorrow, sleeping until midnight buffer", {
    tomorrow,
    sleepMinutes: Math.round(fallbackMs / 60000),
  });

  return fallbackMs;
}

/** Maximum number of days to backfill on startup. */
const MAX_BACKFILL_DAYS = 7;

/**
 * Scans any dates missed between the last recorded play and yesterday.
 * Capped at MAX_BACKFILL_DAYS to avoid hammering the API on a fresh deploy.
 *
 * @param options - Scheduler options (config, db, logger)
 */
async function backfillMissedDays(options: SchedulerOptions): Promise<void> {
  const { db, logger } = options;

  let lastDate: string | null;
  try {
    const row = db.prepare("SELECT MAX(date) as lastDate FROM plays").get() as {
      lastDate: string | null;
    };
    lastDate = row.lastDate;
  } catch {
    logger.warn("could not query last play date, skipping backfill");
    return;
  }

  if (!lastDate) {
    logger.info("no existing plays, skipping backfill");
    return;
  }

  const today = getTodayDate();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = formatDate(yesterday);

  // Nothing to backfill if last play is from yesterday or today
  if (lastDate >= yesterdayStr) {
    logger.info("no missed days to backfill", { lastDate });
    return;
  }

  // Walk from lastDate+1 through yesterday, capped at MAX_BACKFILL_DAYS
  const start = new Date(lastDate + "T00:00:00");
  start.setDate(start.getDate() + 1);

  let daysBackfilled = 0;

  while (formatDate(start) <= yesterdayStr && daysBackfilled < MAX_BACKFILL_DAYS) {
    if (shutdownRequested) break;

    const dateStr = formatDate(start);
    logger.info("backfilling missed date", { date: dateStr });

    try {
      const plays = await scanDate(dateStr, logger);
      if (plays.length > 0) {
        insertPlays(db, plays);
        logger.info("backfill stored plays", {
          date: dateStr,
          count: plays.length,
        });
      }
    } catch (err) {
      logger.error("backfill failed for date", {
        date: dateStr,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    start.setDate(start.getDate() + 1);
    daysBackfilled++;
  }

  if (daysBackfilled > 0) {
    logger.info("backfill complete", { daysBackfilled });
  }
}

/**
 * Long-running peer task that re-runs the Savant video backfill cycle on a
 * fixed interval. Sleep is broken into 1-second slices so a shutdown signal
 * is honored within ~1s without coupling the cycle to scheduler internals.
 *
 * Failures inside a cycle are logged; the loop continues on the next tick.
 */
async function runBackfillLoop(
  db: Database,
  logger: Logger,
  intervalMs: number,
  shouldStop: () => boolean,
): Promise<void> {
  while (!shouldStop()) {
    try {
      await runBackfillCycle(db, logger, { isShuttingDown: shouldStop });
    } catch (err) {
      logger.error("backfill cycle threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const sleepStart = Date.now();
    while (Date.now() - sleepStart < intervalMs && !shouldStop()) {
      await Bun.sleep(1000);
    }
  }
}

/**
 * Main scheduler loop. Runs indefinitely until requestShutdown() is called.
 *
 * On each iteration:
 *   1. Initialize today's schedule and build tracking records.
 *   2. Poll for state changes at the configured interval.
 *   3. When all games resolve, calculate sleep time and advance to next day.
 *
 * @param options - Config, database, and logger
 */
export async function startScheduler(options: SchedulerOptions): Promise<void> {
  const { config, db, logger } = options;
  const pollIntervalMs = config.pollIntervalMinutes * 60 * 1000;
  const backfillIntervalMs = config.backfillIntervalMinutes * 60 * 1000;

  shutdownRequested = false;

  logger.info("scheduler starting", {
    pollIntervalMinutes: config.pollIntervalMinutes,
    backfillIntervalMinutes: config.backfillIntervalMinutes,
    dbPath: config.dbPath,
    slackConfigured: config.slackWebhookUrl !== undefined,
  });

  // Spawn the Savant video backfill loop as a peer task. Fire-and-forget:
  // it observes the shared shutdown flag and exits when the main loop does.
  void runBackfillLoop(db, logger, backfillIntervalMs, isShuttingDown);

  await backfillMissedDays(options);

  while (!shutdownRequested) {
    const today = getTodayDate();
    let tracked: TrackedGame[];

    try {
      tracked = await initializeDaySchedule(today, options);
    } catch (err) {
      logger.error("failed to initialize day schedule", {
        date: today,
        error: err instanceof Error ? err.message : String(err),
      });
      // Wait a bit and retry
      await Bun.sleep(MIN_SLEEP_MS);
      continue;
    }

    updateStatus(tracked, today);

    if (shutdownRequested) break;

    // If no games today, sleep until tomorrow
    if (tracked.length === 0) {
      const sleepMs = await sleepUntilNextDay(logger);
      if (shutdownRequested) break;
      await Bun.sleep(sleepMs);
      continue;
    }

    // Poll loop for the current day
    while (!shutdownRequested) {
      const activeCount = tracked.filter(
        (g) => g.state === "pending" || g.state === "live",
      ).length;

      if (activeCount === 0) {
        updateStatus(tracked, today);
        logger.info("all games for today resolved", {
          date: today,
          total: tracked.length,
          final: tracked.filter((g) => g.state === "final").length,
          abandoned: tracked.filter((g) => g.state === "abandoned").length,
        });
        break;
      }

      logger.debug("polling game states", {
        date: today,
        activeGames: activeCount,
        totalGames: tracked.length,
      });

      await updateGameStates(tracked, today, options);
      updateStatus(tracked, today);

      if (shutdownRequested) break;

      const sleepMs = calculateSleepMs(tracked, pollIntervalMs);
      if (sleepMs > 0) {
        logger.debug("sleeping before next poll", {
          sleepMinutes: Math.round(sleepMs / 60000),
        });
        await Bun.sleep(sleepMs);
      }
    }

    if (shutdownRequested) break;

    // Day is done. Clear active tracking counts before sleeping.
    currentStatus = {
      ...currentStatus,
      gamesTracked: 0,
      gamesLive: 0,
      gamesFinal: 0,
      gamesAbandoned: 0,
    };

    // If the date already advanced while we were processing (games ran past
    // midnight UTC), skip the sleep and let the outer loop pick up the new day.
    if (getTodayDate() !== today) {
      logger.info("date advanced during processing, skipping sleep", {
        trackedDate: today,
        currentDate: getTodayDate(),
      });
      continue;
    }

    // Day is done. Sleep until tomorrow's games.
    const sleepMs = await sleepUntilNextDay(logger);
    if (shutdownRequested) break;
    await Bun.sleep(sleepMs);
  }

  logger.info("scheduler shutting down");
}
