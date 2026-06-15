/**
 * Deterministic backstop for "adjudicated" rule areas.
 *
 * A rule area the operator has repeatedly rejected with zero confirmations
 * is a graveyard: every new finding mapped to it re-litigates a decision
 * already made. The system prompt instructs the model to suppress these,
 * but the model has demonstrably reasoned past that signal — citing the
 * rejection history as if it *strengthened* a finding. This module is the
 * guarantee the prompt can't give.
 *
 * A rule area is adjudicated-against when, over the lookback window, it has
 * 0 confirmed and >= GRAVEYARD_MIN_REJECTED rejected findings. Findings in
 * such an area are moved from `accepted` to `rejected` UNLESS their
 * evidence_strength is "strong" (7+ plays) — a genuinely large new cluster
 * still earns a look and can reopen the area.
 *
 * The "0 confirmed" clause is load-bearing: it protects areas that get
 * confirmed despite the occasional rejection (e.g. direct_throw_bonus,
 * 4 confirmed / 1 rejected). Only areas that have NEVER been confirmed and
 * have been rejected at least twice are silenced.
 *
 * Outcome counts reflect prior runs only: this run's findings are still
 * pending in memory and not yet persisted, so the model's cited counts and
 * this backstop's counts agree.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../../logger";
import type { ValidationResult } from "./validation";

/** Lookback window (weeks) for judging whether a rule area is adjudicated-against. */
export const GRAVEYARD_LOOKBACK_WEEKS = 8;

/**
 * Minimum rejections (with zero confirmations) that mark a rule area as
 * adjudicated-against. Set to 2 so the screen fires the moment a pattern
 * has been rejected twice — matching the threshold stated in the prompt.
 */
export const GRAVEYARD_MIN_REJECTED = 2;

interface AreaOutcome {
  confirmed: number;
  rejected: number;
}

/**
 * Aggregates confirmed/rejected counts per rule area across runs in the
 * past `weeks` weeks. Returns a map keyed by `suspected_rule_area`.
 */
function loadAreaOutcomes(
  db: Database,
  weeks: number,
): Map<string, AreaOutcome> {
  const cutoff = `-${weeks * 7} days`;
  const rows = db
    .prepare(
      `SELECT
         f.suspected_rule_area AS area,
         SUM(CASE WHEN f.outcome = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN f.outcome = 'rejected'  THEN 1 ELSE 0 END) AS rejected
       FROM agent_findings f
       JOIN agent_runs r ON r.id = f.run_id
       WHERE r.week_starting >= date('now', $cutoff)
       GROUP BY f.suspected_rule_area;`,
    )
    .all({ $cutoff: cutoff }) as Array<{
    area: string;
    confirmed: number | null;
    rejected: number | null;
  }>;

  const map = new Map<string, AreaOutcome>();
  for (const row of rows) {
    map.set(row.area, {
      confirmed: row.confirmed ?? 0,
      rejected: row.rejected ?? 0,
    });
  }
  return map;
}

/** True when an area has never been confirmed and has >= MIN rejections. */
function isAdjudicatedAgainst(outcome: AreaOutcome | undefined): boolean {
  if (!outcome) return false;
  return outcome.confirmed === 0 && outcome.rejected >= GRAVEYARD_MIN_REJECTED;
}

/**
 * Moves accepted findings that re-litigate an adjudicated-against rule area
 * into `rejected`, unless their evidence is "strong". Privacy/shape checks
 * have already run; this is a policy screen layered on top.
 *
 * @returns a new ValidationResult; the input is not mutated.
 */
export function suppressAdjudicatedFindings(
  validated: ValidationResult,
  db: Database,
  logger: Logger,
  weeks: number = GRAVEYARD_LOOKBACK_WEEKS,
): ValidationResult {
  const outcomes = loadAreaOutcomes(db, weeks);
  const accepted: ValidationResult["accepted"] = [];
  const rejected: ValidationResult["rejected"] = [...validated.rejected];

  for (const finding of validated.accepted) {
    const outcome = outcomes.get(finding.suspected_rule_area);
    if (
      isAdjudicatedAgainst(outcome) &&
      finding.evidence_strength !== "strong"
    ) {
      const reason = `adjudicated rule area (0 confirmed / ${outcome?.rejected} rejected over ${weeks}w)`;
      logger.info("agent finding suppressed at graveyard screen", {
        finding_type: finding.finding_type,
        suspected_rule_area: finding.suspected_rule_area,
        evidence_strength: finding.evidence_strength,
        reason,
      });
      rejected.push({ finding_type: finding.finding_type, reason });
      continue;
    }
    accepted.push(finding);
  }

  return { accepted, rejected };
}
