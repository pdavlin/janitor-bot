/**
 * One-shot CLI to recover Savant videos for legacy plays that predate the
 * play_id / fetch_status columns.
 *
 * For every row with NULL play_id and NULL video_url, refetch the live feed,
 * extract the playId from the matching play, write it to the row, then run
 * a backfill cycle with no age cutoff.
 *
 * Usage:
 *   bun run src/cli/backfill-historical.ts
 *
 * Run while the daemon is stopped for cleanest results, though concurrent
 * execution is safe under bun:sqlite WAL.
 *
 * Environment:
 *   DB_PATH - path to SQLite database file (default: ./janitor-throws.db)
 *   LOG_LEVEL - logging verbosity (default: info)
 */

import { loadConfig } from "../config";
import { createLogger } from "../logger";
import { createDatabase, updatePlayId } from "../storage/db";
import { fetchLiveFeed } from "../api/mlb-client";
import { extractPlayId } from "../detection/savant-video";
import { runBackfillCycle } from "../daemon/backfill";

/** Effectively unbounded age window for the historical recovery pass. */
const HISTORICAL_WINDOW_DAYS = 36500;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = createDatabase(config.dbPath);

  try {
    const rows = db
      .prepare(
        `
      SELECT DISTINCT game_pk, play_index
      FROM plays
      WHERE play_id IS NULL AND video_url IS NULL
      ORDER BY game_pk, play_index;
    `,
      )
      .all() as { game_pk: number; play_index: number }[];

    logger.info("historical recovery starting", { rowGroups: rows.length });

    const byGame = new Map<number, number[]>();
    for (const row of rows) {
      const list = byGame.get(row.game_pk);
      if (list) {
        list.push(row.play_index);
      } else {
        byGame.set(row.game_pk, [row.play_index]);
      }
    }

    let playsPopulated = 0;
    for (const [gamePk, playIndices] of byGame) {
      try {
        const feed = await fetchLiveFeed(gamePk);
        for (const playIndex of playIndices) {
          const livePlay = feed.liveData.plays.allPlays.find(
            (p) => p.about.atBatIndex === playIndex,
          );
          const playId = extractPlayId(livePlay?.playEvents);
          if (!playId) {
            logger.warn("no playId extractable for legacy row", {
              gamePk,
              playIndex,
            });
            continue;
          }
          const updated = updatePlayId(db, gamePk, playIndex, playId);
          if (updated > 0) playsPopulated++;
        }
      } catch (err) {
        logger.error("live feed fetch failed during historical recovery", {
          gamePk,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("playId population complete", {
      games: byGame.size,
      playsPopulated,
    });

    const stats = await runBackfillCycle(db, logger, {
      windowDays: HISTORICAL_WINDOW_DAYS,
    });
    logger.info("historical recovery complete", { ...stats });
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(
    "Fatal error:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
