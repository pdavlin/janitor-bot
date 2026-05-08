import type { Database } from "bun:sqlite";
import type { Severity, EvidenceStrength, Outcome } from "../types";

export interface PriorFindingDescriptionResult {
  findingId: number;
  runId: number;
  weekStarting: string;
  finding_type: string;
  description: string | null;
  severity: Severity;
  evidence_strength: EvidenceStrength;
  suspected_rule_area: string;
  outcome: Outcome;
}

/**
 * Returns the full row for a prior finding by id. The `description`
 * field already passed validation when persisted (no quotes,
 * mentions, or transcript substrings), so re-surfacing it back to the
 * agent is safe. The retention sweep nulls descriptions older than 12
 * weeks; a null is forwarded as-is.
 */
export function getPriorFindingDescription(
  db: Database,
  findingId: number,
): PriorFindingDescriptionResult | { error: "not_found" } {
  const row = db
    .prepare(
      `SELECT f.id, f.run_id, r.week_starting, f.finding_type, f.description,
              f.severity, f.evidence_strength, f.suspected_rule_area, f.outcome
       FROM agent_findings f
       JOIN agent_runs r ON r.id = f.run_id
       WHERE f.id = $findingId
       LIMIT 1;`,
    )
    .get({ $findingId: findingId }) as
    | {
        id: number;
        run_id: number;
        week_starting: string;
        finding_type: string;
        description: string | null;
        severity: Severity;
        evidence_strength: EvidenceStrength;
        suspected_rule_area: string;
        outcome: Outcome;
      }
    | null;
  if (!row) return { error: "not_found" };
  return {
    findingId: row.id,
    runId: row.run_id,
    weekStarting: row.week_starting,
    finding_type: row.finding_type,
    description: row.description,
    severity: row.severity,
    evidence_strength: row.evidence_strength,
    suspected_rule_area: row.suspected_rule_area,
    outcome: row.outcome,
  };
}
