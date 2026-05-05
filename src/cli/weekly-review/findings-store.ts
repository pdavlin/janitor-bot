/**
 * Persistence helpers for `agent_runs` and `agent_findings`.
 *
 * The functions here are the only writers to these tables once the
 * lock has been acquired. Findings are inserted in a single
 * transaction so a partial failure doesn't leave the run with a
 * half-populated set. The retention sweep + auto-close run after a
 * successful digest post.
 */

import type { Database } from "bun:sqlite";
import type { Finding, FindingRow, HitRate, Trend, Outcome } from "./types";

/** Inserts every finding for a run inside one transaction. */
export function persistFindings(
  db: Database,
  runId: number,
  findings: readonly Finding[],
): void {
  if (findings.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO agent_findings (
      run_id, finding_type, description, severity, evidence_strength,
      evidence_play_ids, suspected_rule_area, trend
    ) VALUES (
      $runId, $type, $desc, $sev, $strength, $plays, $area, $trend
    );
  `);

  const tx = db.transaction((items: readonly Finding[]) => {
    for (const f of items) {
      insert.run({
        $runId: runId,
        $type: f.finding_type,
        $desc: f.description,
        $sev: f.severity,
        $strength: f.evidence_strength,
        $plays: JSON.stringify(f.evidence_play_ids),
        $area: f.suspected_rule_area,
        $trend: f.trend,
      });
    }
  });
  tx(findings);
}

/**
 * Stamps cost telemetry and the posted Slack `ts` onto an existing
 * `agent_runs` row. Status transitions stay with `lock.release`.
 */
export function recordAgentTelemetry(
  db: Database,
  runId: number,
  inputTokens: number,
  outputTokens: number,
  estimatedCostUsd: number,
  postedMessageTs: string | null,
): void {
  db.prepare(
    `
    UPDATE agent_runs
    SET input_tokens = $in,
        output_tokens = $out,
        estimated_cost_usd = $cost,
        posted_message_ts = $ts
    WHERE id = $runId;
  `,
  ).run({
    $in: inputTokens,
    $out: outputTokens,
    $cost: estimatedCostUsd,
    $ts: postedMessageTs,
    $runId: runId,
  });
}

/**
 * Nulls prose columns past the 12-week retention horizon. Idempotent:
 * rows already nulled are no-ops. Targets BOTH `play_tags.matched_text`
 * and `agent_findings.description` per FR-5.51 / FR-5.52.
 *
 * The `play_tags` table may not exist when phase 3 hasn't landed; we
 * silently skip in that case.
 */
export function runRetentionSweep(db: Database, weeks = 12): void {
  // SQLite's datetime modifiers do not include `weeks`; convert to days.
  const cutoff = `-${weeks * 7} days`;
  try {
    db.prepare(
      `UPDATE play_tags SET matched_text = NULL WHERE received_at < datetime('now', $cutoff);`,
    ).run({ $cutoff: cutoff });
  } catch (err) {
    if (!isNoSuchTableError(err, "play_tags")) throw err;
  }
  db.prepare(
    `UPDATE agent_findings SET description = NULL WHERE created_at < datetime('now', $cutoff);`,
  ).run({ $cutoff: cutoff });
}

/**
 * Findings older than `days` with `outcome='pending'` are auto-closed
 * to `'ignored'`. Wall-clock based, not week-relative — a `--week-starting`
 * replay does not delay auto-closure for findings created during the
 * replayed week.
 */
export function autoCloseStaleFindings(db: Database, days = 14): void {
  db.prepare(
    `
    UPDATE agent_findings
    SET outcome = 'ignored', resolved_at = datetime('now')
    WHERE outcome = 'pending'
      AND created_at < datetime('now', $cutoff);
  `,
  ).run({ $cutoff: `-${days} days` });
}

/**
 * Computes the confirmed-rate over the past `weeks` weeks. Used in the
 * digest's hit-rate footer. Only `confirmed`/`rejected` are counted as
 * "resolved"; `pending` and `ignored` are excluded from the
 * denominator.
 */
export function getHitRate(db: Database, weeks = 8): HitRate {
  const row = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN f.outcome = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN f.outcome IN ('confirmed', 'rejected') THEN 1 ELSE 0 END) AS resolved
      FROM agent_findings f
      JOIN agent_runs r ON r.id = f.run_id
      WHERE r.week_starting >= date('now', $cutoff);
    `,
    )
    .get({ $cutoff: `-${weeks * 7} days` }) as {
    confirmed: number | null;
    resolved: number | null;
  };
  return {
    confirmed: row.confirmed ?? 0,
    total: row.resolved ?? 0,
  };
}

/**
 * Resolves a single finding to `confirmed` or `rejected`. Used by the
 * `--resolve` CLI mode. Returns true iff the row existed and matched
 * the run id.
 */
export function resolveFinding(
  db: Database,
  runId: number,
  findingId: number,
  outcome: Extract<Outcome, "confirmed" | "rejected">,
): boolean {
  const latestSuccessRow = db
    .prepare(
      `SELECT id FROM agent_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1;`,
    )
    .get() as { id: number } | null;

  const result = db
    .prepare(
      `
      UPDATE agent_findings
      SET outcome = $outcome,
          resolved_at = datetime('now'),
          resolved_by_run_id = $runId
      WHERE id = $findingId AND run_id = $expectedRun;
    `,
    )
    .run({
      $outcome: outcome,
      $runId: latestSuccessRow?.id ?? null,
      $findingId: findingId,
      $expectedRun: runId,
    });
  return Number(result.changes) > 0;
}

/**
 * Returns past findings within `weeks` of the target week's start.
 * Used by the prompt builder so the agent can confirm/contradict prior
 * patterns. Includes the joined `week_starting` for chronological
 * context.
 */
export function queryPriorFindings(
  db: Database,
  weekStarting: string,
  weeks: number,
): FindingRow[] {
  const rows = db
    .prepare(
      `
      SELECT f.*, r.week_starting AS week_starting
      FROM agent_findings f
      JOIN agent_runs r ON r.id = f.run_id
      WHERE r.week_starting >= date($week, $cutoff)
        AND r.week_starting < $week
        AND r.status = 'success'
      ORDER BY r.week_starting ASC, f.id ASC;
    `,
    )
    .all({
      $week: weekStarting,
      $cutoff: `-${weeks * 7} days`,
    }) as FindingRow[];
  return rows;
}

/** Returns the most recent successful run's findings, in stored order. */
export function queryLastRunFindings(
  db: Database,
): { run: { id: number; week_starting: string } | null; findings: FindingRow[] } {
  const run = db
    .prepare(
      `SELECT id, week_starting FROM agent_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1;`,
    )
    .get() as { id: number; week_starting: string } | null;
  if (!run) return { run: null, findings: [] };

  const findings = db
    .prepare(
      `SELECT * FROM agent_findings WHERE run_id = $runId ORDER BY id ASC;`,
    )
    .all({ $runId: run.id }) as FindingRow[];

  return { run, findings };
}

function isNoSuchTableError(err: unknown, tableName: string): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes(`no such table: ${tableName}`);
}

// `Trend` is only re-exported so the CLI can import it from a single
// module; not used directly here.
export type { Trend };
