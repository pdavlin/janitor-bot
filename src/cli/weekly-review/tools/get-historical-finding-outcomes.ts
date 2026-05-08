import type { Database } from "bun:sqlite";

export interface HistoricalFindingOutcomesResult {
  ruleArea: string;
  weeks: number;
  confirmed: number;
  rejected: number;
  pending: number;
  ignored: number;
}

/**
 * Aggregates outcomes for findings whose `suspected_rule_area`
 * matches `suspectedRuleArea`, scoped to runs in the past `weeks`
 * weeks. Useful for the agent to check whether a pattern has
 * recurred. SQLite has no `weeks` modifier; we convert to days.
 */
export function getHistoricalFindingOutcomes(
  db: Database,
  suspectedRuleArea: string,
  weeks: number,
): HistoricalFindingOutcomesResult {
  const cutoff = `-${weeks * 7} days`;
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN f.outcome = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN f.outcome = 'rejected'  THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN f.outcome = 'pending'   THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN f.outcome = 'ignored'   THEN 1 ELSE 0 END) AS ignored
       FROM agent_findings f
       JOIN agent_runs r ON r.id = f.run_id
       WHERE f.suspected_rule_area = $area
         AND r.week_starting >= date('now', $cutoff);`,
    )
    .get({ $area: suspectedRuleArea, $cutoff: cutoff }) as {
    confirmed: number | null;
    rejected: number | null;
    pending: number | null;
    ignored: number | null;
  };
  return {
    ruleArea: suspectedRuleArea,
    weeks,
    confirmed: row.confirmed ?? 0,
    rejected: row.rejected ?? 0,
    pending: row.pending ?? 0,
    ignored: row.ignored ?? 0,
  };
}
