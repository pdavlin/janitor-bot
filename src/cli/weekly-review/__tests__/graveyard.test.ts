import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../../storage/db";
import { createLogger } from "../../../logger";
import { suppressAdjudicatedFindings } from "../graveyard";
import type { Finding } from "../types";
import type { ValidationResult } from "../validation";

const silentLogger = createLogger("error");

// Large lookback so the screen is independent of wall-clock: every seeded
// run (week_starting "2020-01-01") falls inside the window.
const WIDE_WEEKS = 100_000;

let db: Database;
let runSeq = 0;

beforeEach(() => {
  db = createDatabase(":memory:");
  runSeq = 0;
});

/** Inserts a finding in `area` with `outcome` on a fresh in-window run. */
function seedFinding(area: string, outcome: string): void {
  runSeq += 1;
  db.run(
    `INSERT INTO agent_runs (week_starting, model, started_at, status)
     VALUES ('2020-01-01', 'test-model', '2020-01-01T00:00:00Z', 'success');`,
  );
  const runId = db
    .prepare(`SELECT id FROM agent_runs ORDER BY id DESC LIMIT 1;`)
    .get() as { id: number };
  db.prepare(
    `INSERT INTO agent_findings
       (run_id, finding_type, description, severity, evidence_strength,
        evidence_play_ids, suspected_rule_area, trend, outcome)
     VALUES ($run, $type, 'd', 'watch', 'moderate', '[1,2]', $area, 'recurring', $outcome);`,
  ).run({
    $run: runId.id,
    $type: `seed_${runSeq}`,
    $area: area,
    $outcome: outcome,
  });
}

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  finding_type: "candidate",
  description: "A candidate finding.",
  severity: "watch",
  evidence_strength: "moderate",
  evidence_play_ids: [1, 2, 3, 4],
  suspected_rule_area: "ranking.ts:tier_thresholds",
  trend: "recurring",
  ...overrides,
});

const asValidation = (accepted: Finding[]): ValidationResult => ({
  accepted,
  rejected: [],
});

describe("suppressAdjudicatedFindings", () => {
  test("drops a sub-strong finding in a 0-confirmed / 2-rejected area", () => {
    seedFinding("ranking.ts:tier_thresholds", "rejected");
    seedFinding("ranking.ts:tier_thresholds", "rejected");

    const result = suppressAdjudicatedFindings(
      asValidation([finding()]),
      db,
      silentLogger,
      WIDE_WEEKS,
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.finding_type).toBe("candidate");
    expect(result.rejected[0]?.reason).toContain("adjudicated rule area");
  });

  test("keeps a strong finding even in an adjudicated area (reopen path)", () => {
    seedFinding("ranking.ts:tier_thresholds", "rejected");
    seedFinding("ranking.ts:tier_thresholds", "rejected");
    seedFinding("ranking.ts:tier_thresholds", "rejected");

    const result = suppressAdjudicatedFindings(
      asValidation([finding({ evidence_strength: "strong" })]),
      db,
      silentLogger,
      WIDE_WEEKS,
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("keeps a finding in an area with a confirmation despite rejections", () => {
    // 4 confirmed / 1 rejected — healthy, like direct_throw_bonus.
    seedFinding("ranking.ts:direct_throw_bonus", "confirmed");
    seedFinding("ranking.ts:direct_throw_bonus", "confirmed");
    seedFinding("ranking.ts:direct_throw_bonus", "rejected");

    const result = suppressAdjudicatedFindings(
      asValidation([finding({ suspected_rule_area: "ranking.ts:direct_throw_bonus" })]),
      db,
      silentLogger,
      WIDE_WEEKS,
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("keeps a finding in an area with only one rejection", () => {
    seedFinding("ranking.ts:video_bonus", "rejected");

    const result = suppressAdjudicatedFindings(
      asValidation([finding({ suspected_rule_area: "ranking.ts:video_bonus" })]),
      db,
      silentLogger,
      WIDE_WEEKS,
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("keeps a finding in an area with no history", () => {
    const result = suppressAdjudicatedFindings(
      asValidation([finding({ suspected_rule_area: "new_tunable_needed" })]),
      db,
      silentLogger,
      WIDE_WEEKS,
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("preserves pre-existing rejections and appends suppressed ones", () => {
    seedFinding("ranking.ts:target_base_scores", "rejected");
    seedFinding("ranking.ts:target_base_scores", "rejected");

    const validated: ValidationResult = {
      accepted: [finding({ suspected_rule_area: "ranking.ts:target_base_scores" })],
      rejected: [{ finding_type: "earlier", reason: "description contains a URL" }],
    };

    const result = suppressAdjudicatedFindings(validated, db, silentLogger, WIDE_WEEKS);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.map((r) => r.finding_type)).toEqual([
      "earlier",
      "candidate",
    ]);
  });

  test("does not count rejections outside the lookback window", () => {
    seedFinding("ranking.ts:tier_thresholds", "rejected");
    seedFinding("ranking.ts:tier_thresholds", "rejected");

    // 1-week lookback: seeded runs are dated 2020, far outside the window.
    const result = suppressAdjudicatedFindings(
      asValidation([finding()]),
      db,
      silentLogger,
      1,
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });
});
