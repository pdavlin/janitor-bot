/**
 * One-shot CLI to backfill throw_velocity on existing plays.
 *
 * Iterates plays with a play_id and NULL throw_velocity, resolves
 * velocity via arm-velocity.ts (cached by fielder/year), and writes
 * the result. Idempotent: re-running skips already-filled rows.
 *
 * Never recomputes tier or touches Slack tables.
 *
 * Usage:
 *   bun run src/cli/backfill-throw-velocity.ts
 *
 * Run against a copy of the prod DB first to confirm idempotency
 * and the no-tier-change invariant before touching prod.
 *
 * Environment:
 *   DB_PATH - path to SQLite database file (default: ./janitor-throws.db)
 *   LOG_LEVEL - logging verbosity (default: info)
 */

import { loadConfig } from "../config";
import { createLogger } from "../logger";
import { createDatabase } from "../storage/db";
import { resolveThrowVelocity } from "../detection/arm-velocity";

interface BackfillRow {
  game_pk: number;
  play_index: number;
  date: string;
  fielder_id: number;
  play_id: string;
}

/**
 * Returns a stable string of the tier distribution (`tier: count` rows),
 * used to assert the backfill never mutates the tier column.
 */
function snapshotTiers(db: import("bun:sqlite").Database): string {
  const rows = db
    .prepare("SELECT tier, COUNT(*) as count FROM plays GROUP BY tier ORDER BY tier;")
    .all() as { tier: string; count: number }[];
  return rows.map((r) => `${r.tier}:${r.count}`).join(",");
}

export interface BackfillSummary {
  matched: number;
  noMatch: number;
  errors: number;
  tierInvariantHeld: boolean;
}

/**
 * Core backfill over an already-open DB. Writes only throw_velocity and
 * throw_velocity_status; asserts the tier distribution is unchanged.
 * The caller owns the db lifecycle (this does not close it).
 */
export async function runBackfill(
  db: import("bun:sqlite").Database,
  logger: ReturnType<typeof createLogger>,
): Promise<BackfillSummary> {
  // Snapshot the tier distribution up front to assert it is untouched.
  const tierBefore = snapshotTiers(db);

  {
    // Select plays that have a play_id but no throw_velocity yet
    const rows = db
      .prepare(
        `
      SELECT DISTINCT game_pk, play_index, date, fielder_id, play_id
      FROM plays
      WHERE play_id IS NOT NULL
        AND throw_velocity IS NULL
        AND throw_velocity_status IS NULL
      ORDER BY date DESC, game_pk, play_index;
    `,
      )
      .all() as BackfillRow[];

    logger.info("throw-velocity backfill starting", {
      eligiblePlays: rows.length,
    });

    if (rows.length === 0) {
      logger.info("no plays need backfill");
      return { matched: 0, noMatch: 0, errors: 0, tierInvariantHeld: true };
    }

    // Group by (fielder_id, year) for cache efficiency
    const byFielderYear = new Map<
      string,
      { fielderId: number; year: number; plays: BackfillRow[] }
    >();

    for (const row of rows) {
      const year = Number(row.date.slice(0, 4));
      const key = `${row.fielder_id}:${year}`;
      const group = byFielderYear.get(key);
      if (group) {
        group.plays.push(row);
      } else {
        byFielderYear.set(key, {
          fielderId: row.fielder_id,
          year,
          plays: [row],
        });
      }
    }

    logger.info("grouped by fielder/year", {
      groups: byFielderYear.size,
    });

    let matched = 0;
    let noMatch = 0;
    let errors = 0;

    // Process each group (one HTTP request per group due to caching)
    for (const [_key, group] of byFielderYear) {
      for (const play of group.plays) {
        try {
          const result = await resolveThrowVelocity(
            group.fielderId,
            group.year,
            play.play_id,
            logger,
          );

          if (result.status === "matched") {
            // Write velocity + status; never touch tier or Slack tables.
            db.prepare(
              `UPDATE plays SET throw_velocity = $velocity, throw_velocity_status = 'matched' WHERE game_pk = $gamePk AND play_index = $playIndex AND throw_velocity IS NULL;`,
            ).run({
              $velocity: result.velocityMph,
              $gamePk: play.game_pk,
              $playIndex: play.play_index,
            });
            matched++;
          } else if (result.status === "no_match") {
            // Untracked throw: record the status so we skip it on re-run,
            // leaving throw_velocity NULL (no magic sentinel value).
            db.prepare(
              `UPDATE plays SET throw_velocity_status = 'no_match' WHERE game_pk = $gamePk AND play_index = $playIndex AND throw_velocity_status IS NULL;`,
            ).run({
              $gamePk: play.game_pk,
              $playIndex: play.play_index,
            });
            noMatch++;
          } else {
            // Fetch error: leave velocity AND status NULL so it can be retried
            logger.debug("velocity fetch non-success during backfill", {
              gamePk: play.game_pk,
              playIndex: play.play_index,
              fielderId: group.fielderId,
              year: group.year,
              status: result.status,
            });
            errors++;
          }
        } catch (err) {
          logger.error("unexpected error during backfill", {
            gamePk: play.game_pk,
            playIndex: play.play_index,
            error: err instanceof Error ? err.message : String(err),
          });
          errors++;
        }
      }

      // Progress logging every group
      logger.info("backfill progress", {
        processed: matched + noMatch + errors,
        matched,
        noMatch,
        errors,
      });
    }

    logger.info("throw-velocity backfill complete", {
      total: rows.length,
      matched,
      noMatch,
      errors,
    });

    // Real invariant check: the tier distribution must be byte-identical
    // before and after. This script only writes throw_velocity[_status],
    // so any tier delta would signal an unintended write.
    const tierAfter = snapshotTiers(db);
    const tierInvariantHeld = tierAfter === tierBefore;
    if (!tierInvariantHeld) {
      logger.error("INVARIANT VIOLATED: tier distribution changed", {
        before: tierBefore,
        after: tierAfter,
      });
    } else {
      logger.info("invariant verified: tier distribution unchanged", {
        tiers: tierAfter,
      });
    }

    return { matched, noMatch, errors, tierInvariantHeld };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = createDatabase(config.dbPath);
  try {
    await runBackfill(db, logger);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      "Fatal error:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}
