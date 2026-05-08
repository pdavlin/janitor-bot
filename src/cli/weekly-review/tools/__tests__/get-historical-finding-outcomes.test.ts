import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../../../storage/db";
import { acquireLock } from "../../lock";
import { persistFindings } from "../../findings-store";
import { getHistoricalFindingOutcomes } from "../get-historical-finding-outcomes";
import type { Finding } from "../../types";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

const RULE_AREA = "ranking.ts:target_base_scores";

function sample(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_type: "rf_home_pushback",
    description: "abstract pattern",
    severity: "watch",
    evidence_strength: "moderate",
    evidence_play_ids: [1, 2],
    suspected_rule_area: RULE_AREA,
    trend: "first_seen",
    ...overrides,
  };
}

describe("getHistoricalFindingOutcomes", () => {
  test("aggregates outcomes within the window", () => {
    const lockA = acquireLock(db, "2026-04-19", "claude-sonnet-4-6");
    persistFindings(db, lockA.runId, [
      sample({ finding_type: "a1" }),
      sample({ finding_type: "a2" }),
      sample({ finding_type: "a3" }),
    ]);
    lockA.release("success");
    const ids = db.prepare("SELECT id FROM agent_findings ORDER BY id ASC;").all() as { id: number }[];
    db.prepare("UPDATE agent_findings SET outcome = 'confirmed' WHERE id = $id;").run({ $id: ids[0]!.id });
    db.prepare("UPDATE agent_findings SET outcome = 'rejected' WHERE id = $id;").run({ $id: ids[1]!.id });

    const out = getHistoricalFindingOutcomes(db, RULE_AREA, 8);
    expect(out.ruleArea).toBe(RULE_AREA);
    expect(out.weeks).toBe(8);
    expect(out.confirmed).toBe(1);
    expect(out.rejected).toBe(1);
    expect(out.pending).toBe(1);
    expect(out.ignored).toBe(0);
  });

  test("excludes runs older than the window", () => {
    const lock = acquireLock(db, "2025-10-05", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sample()]);
    lock.release("success");

    const out = getHistoricalFindingOutcomes(db, RULE_AREA, 8);
    expect(out.confirmed + out.rejected + out.pending + out.ignored).toBe(0);
  });

  test("returns zeros when no findings match the rule area", () => {
    const lock = acquireLock(db, "2026-04-19", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sample({ suspected_rule_area: "other_area" })]);
    lock.release("success");

    const out = getHistoricalFindingOutcomes(db, RULE_AREA, 8);
    expect(out).toEqual({
      ruleArea: RULE_AREA,
      weeks: 8,
      confirmed: 0,
      rejected: 0,
      pending: 0,
      ignored: 0,
    });
  });

  test("does not return raw description or prose", () => {
    const out = getHistoricalFindingOutcomes(db, RULE_AREA, 8);
    expect(out).not.toHaveProperty("description");
    expect(out).not.toHaveProperty("text");
    expect(out).not.toHaveProperty("message");
    expect(out).not.toHaveProperty("transcript");
    expect(out).not.toHaveProperty("matched_text");
  });
});
