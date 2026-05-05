#!/usr/bin/env bun
/**
 * One-shot migration that rewrites historical plays that landed with
 * `target_base = '4B'` to `target_base = 'Home'` and recomputes their
 * tier so the under-tiering bug (4B was scoring +1 instead of +4) is
 * corrected in place.
 *
 * The bug: an earlier version of `BASE_LABELS` in `src/detection/detect.ts`
 * did not map the API's `"4B"` token for plate-out plays, so rows
 * stored the raw `"4B"` and `calculateTier` fell through to the +1
 * branch instead of giving home plays +4. The label is fixed at the
 * source on the same branch as this script; this script repairs the
 * existing data.
 *
 * Run after deploy:
 *
 *   PATH=/home/exedev/.bun/bin:$PATH bun run \
 *     scripts/backfill-target-base-home.ts
 *
 * Idempotent — running it a second time is a no-op because the WHERE
 * clause filters on `target_base = '4B'`.
 *
 * Pass `--dry-run` to inspect counts and a per-row tier transition
 * report without writing.
 */

import { Database } from "bun:sqlite";
import { calculateTier } from "../src/detection/ranking";
import type { Tier } from "../src/types/play";

interface AffectedRow {
  id: number;
  game_pk: number;
  play_index: number;
  credit_chain: string;
  video_url: string | null;
  tier: Tier;
}

interface RecomputedRow {
  id: number;
  game_pk: number;
  play_index: number;
  oldTier: Tier;
  newTier: Tier;
  changed: boolean;
}

function findAffectedRows(db: Database): AffectedRow[] {
  return db
    .prepare(
      `SELECT id, game_pk, play_index, credit_chain, video_url, tier
       FROM plays
       WHERE target_base = '4B'
       ORDER BY id ASC;`,
    )
    .all() as AffectedRow[];
}

function recomputeTiers(rows: AffectedRow[]): RecomputedRow[] {
  return rows.map((r) => {
    const newTier = calculateTier({
      targetBase: "Home",
      creditChain: r.credit_chain,
      hasVideo: r.video_url !== null,
    });
    return {
      id: r.id,
      game_pk: r.game_pk,
      play_index: r.play_index,
      oldTier: r.tier,
      newTier,
      changed: r.tier !== newTier,
    };
  });
}

function applyMigration(db: Database, recomputed: RecomputedRow[]): void {
  const update = db.prepare(
    `UPDATE plays SET target_base = 'Home', tier = $tier WHERE id = $id;`,
  );
  const tx = db.transaction((items: RecomputedRow[]) => {
    for (const r of items) update.run({ $id: r.id, $tier: r.newTier });
  });
  tx(recomputed);
}

function summarize(recomputed: RecomputedRow[]): {
  total: number;
  retiered: number;
  byTransition: Record<string, number>;
} {
  const byTransition: Record<string, number> = {};
  let retiered = 0;
  for (const r of recomputed) {
    if (r.changed) retiered++;
    const key = `${r.oldTier} -> ${r.newTier}`;
    byTransition[key] = (byTransition[key] ?? 0) + 1;
  }
  return { total: recomputed.length, retiered, byTransition };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const dbPath = process.env.DB_PATH ?? "./janitor-throws.db";

  const db = new Database(dbPath);
  try {
    const affected = findAffectedRows(db);
    if (affected.length === 0) {
      process.stdout.write("no rows with target_base='4B' — nothing to do\n");
      return;
    }

    const recomputed = recomputeTiers(affected);
    const summary = summarize(recomputed);

    process.stdout.write(
      `Found ${summary.total} rows with target_base='4B'. ` +
        `${summary.retiered} would change tier:\n`,
    );
    for (const [transition, count] of Object.entries(summary.byTransition)) {
      process.stdout.write(`  ${transition}: ${count}\n`);
    }

    if (dryRun) {
      process.stdout.write("\n--dry-run: no rows updated\n");
      return;
    }

    applyMigration(db, recomputed);
    process.stdout.write(
      `\nUpdated ${summary.total} rows (target_base='Home', tier recomputed).\n`,
    );
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}

export { findAffectedRows, recomputeTiers, applyMigration, summarize };
