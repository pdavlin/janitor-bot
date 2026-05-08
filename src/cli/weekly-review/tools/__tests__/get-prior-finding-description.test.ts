import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../../../storage/db";
import { acquireLock } from "../../lock";
import { persistFindings } from "../../findings-store";
import { getPriorFindingDescription } from "../get-prior-finding-description";
import type { Finding } from "../../types";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

function sample(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_type: "rf_home_pushback",
    description: "Channel pushed back on RF -> Home throws across multiple plays.",
    severity: "watch",
    evidence_strength: "moderate",
    evidence_play_ids: [1, 2, 3],
    suspected_rule_area: "ranking.ts:target_base_scores",
    trend: "first_seen",
    ...overrides,
  };
}

describe("getPriorFindingDescription", () => {
  test("returns the full row including description", () => {
    const lock = acquireLock(db, "2026-04-19", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sample()]);
    lock.release("success");
    const id = (db.prepare("SELECT id FROM agent_findings LIMIT 1;").get() as { id: number }).id;

    const result = getPriorFindingDescription(db, id);
    if ("error" in result) throw new Error("expected row");
    expect(result.findingId).toBe(id);
    expect(result.runId).toBe(lock.runId);
    expect(result.weekStarting).toBe("2026-04-19");
    expect(result.finding_type).toBe("rf_home_pushback");
    expect(result.description).toContain("Channel pushed back");
    expect(result.severity).toBe("watch");
    expect(result.evidence_strength).toBe("moderate");
    expect(result.suspected_rule_area).toBe("ranking.ts:target_base_scores");
    expect(result.outcome).toBe("pending");
  });

  test("returns not_found for unknown id", () => {
    expect(getPriorFindingDescription(db, 9999)).toEqual({ error: "not_found" });
  });

  test("forwards a null description when retention nulled it", () => {
    const lock = acquireLock(db, "2026-04-19", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sample()]);
    db.run("UPDATE agent_findings SET description = NULL;");
    const id = (db.prepare("SELECT id FROM agent_findings LIMIT 1;").get() as { id: number }).id;

    const result = getPriorFindingDescription(db, id);
    if ("error" in result) throw new Error("expected row");
    expect(result.description).toBeNull();
  });

  test("does not include any transcript-style fields", () => {
    const lock = acquireLock(db, "2026-04-19", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sample()]);
    const id = (db.prepare("SELECT id FROM agent_findings LIMIT 1;").get() as { id: number }).id;

    const result = getPriorFindingDescription(db, id);
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("message");
    expect(result).not.toHaveProperty("transcript");
    expect(result).not.toHaveProperty("matched_text");
  });
});
