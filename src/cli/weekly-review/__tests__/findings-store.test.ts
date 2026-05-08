import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../../storage/db";
import { acquireLock } from "../lock";
import {
  persistFindings,
  recordAgentTelemetry,
  runRetentionSweep,
  autoCloseStaleFindings,
  getHitRate,
  resolveFinding,
  queryPriorFindings,
  queryLastRunFindings,
} from "../findings-store";
import type { Finding } from "../types";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

const sampleFinding = (overrides: Partial<Finding> = {}): Finding => ({
  finding_type: "rf_home_pushback",
  description: "Channel pushed back on RF to Home across multiple plays.",
  severity: "watch",
  evidence_strength: "moderate",
  evidence_play_ids: [1, 2, 3, 4],
  suspected_rule_area: "ranking.ts:target_base_scores",
  trend: "first_seen",
  ...overrides,
});

describe("persistFindings", () => {
  test("inserts findings linked to the run", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sampleFinding(), sampleFinding({ finding_type: "other" })]);

    const rows = db
      .prepare(`SELECT * FROM agent_findings WHERE run_id = $id ORDER BY id ASC;`)
      .all({ $id: lock.runId }) as { finding_type: string; evidence_play_ids: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.finding_type).toBe("rf_home_pushback");
    expect(JSON.parse(rows[0]!.evidence_play_ids)).toEqual([1, 2, 3, 4]);
  });

  test("is a no-op for an empty findings array", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, []);
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM agent_findings WHERE run_id = $id;`)
      .get({ $id: lock.runId }) as { c: number };
    expect(count.c).toBe(0);
  });
});

describe("recordAgentTelemetry", () => {
  test("stamps cost + posted ts + tool telemetry onto the run row", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    recordAgentTelemetry(
      db,
      lock.runId,
      1234,
      567,
      0.0123,
      "1700000000.000100",
      4,
      { getVoteSnapshot: 3, getPlayDetails: 1 },
    );

    const row = db
      .prepare(
        `SELECT input_tokens, output_tokens, estimated_cost_usd, posted_message_ts,
                tool_call_count, tool_call_breakdown
         FROM agent_runs WHERE id = $id;`,
      )
      .get({ $id: lock.runId }) as {
      input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: number;
      posted_message_ts: string;
      tool_call_count: number;
      tool_call_breakdown: string;
    };
    expect(row.input_tokens).toBe(1234);
    expect(row.output_tokens).toBe(567);
    expect(row.estimated_cost_usd).toBeCloseTo(0.0123, 4);
    expect(row.posted_message_ts).toBe("1700000000.000100");
    expect(row.tool_call_count).toBe(4);
    expect(JSON.parse(row.tool_call_breakdown)).toEqual({
      getVoteSnapshot: 3,
      getPlayDetails: 1,
    });
  });

  test("serializes an empty breakdown as {}", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    recordAgentTelemetry(db, lock.runId, 0, 0, 0, null, 0, {});
    const row = db
      .prepare(`SELECT tool_call_count, tool_call_breakdown FROM agent_runs WHERE id = $id;`)
      .get({ $id: lock.runId }) as { tool_call_count: number; tool_call_breakdown: string };
    expect(row.tool_call_count).toBe(0);
    expect(row.tool_call_breakdown).toBe("{}");
  });
});

describe("runRetentionSweep", () => {
  test("nulls agent_findings.description for old rows and tolerates missing play_tags", () => {
    const lock = acquireLock(db, "2025-01-05", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sampleFinding()]);
    db.run(`UPDATE agent_findings SET created_at = datetime('now', '-105 days');`);

    runRetentionSweep(db);

    const desc = db
      .prepare(`SELECT description FROM agent_findings;`)
      .get() as { description: string | null };
    expect(desc.description).toBeNull();
  });

  test("is idempotent", () => {
    const lock = acquireLock(db, "2025-01-05", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sampleFinding()]);
    db.run(`UPDATE agent_findings SET created_at = datetime('now', '-105 days');`);

    runRetentionSweep(db);
    runRetentionSweep(db);

    const desc = db.prepare(`SELECT description FROM agent_findings;`).get() as {
      description: string | null;
    };
    expect(desc.description).toBeNull();
  });
});

describe("autoCloseStaleFindings", () => {
  test("flips pending rows older than 14 days to ignored", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sampleFinding()]);
    db.run(`UPDATE agent_findings SET created_at = datetime('now', '-30 days');`);

    autoCloseStaleFindings(db);

    const row = db.prepare(`SELECT outcome, resolved_at FROM agent_findings;`).get() as {
      outcome: string;
      resolved_at: string | null;
    };
    expect(row.outcome).toBe("ignored");
    expect(row.resolved_at).not.toBeNull();
  });

  test("leaves recent pending rows alone", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sampleFinding()]);

    autoCloseStaleFindings(db);

    const row = db.prepare(`SELECT outcome FROM agent_findings;`).get() as {
      outcome: string;
    };
    expect(row.outcome).toBe("pending");
  });
});

describe("getHitRate / resolveFinding", () => {
  test("returns zeros when no findings have been resolved", () => {
    expect(getHitRate(db)).toEqual({ confirmed: 0, total: 0 });
  });

  test("counts confirmed and rejected against the denominator", () => {
    const lockA = acquireLock(db, "2026-04-19", "claude-sonnet-4-6");
    persistFindings(db, lockA.runId, [
      sampleFinding({ finding_type: "a1" }),
      sampleFinding({ finding_type: "a2" }),
    ]);
    lockA.release("success");

    const findings = db
      .prepare(`SELECT id FROM agent_findings;`)
      .all() as { id: number }[];
    expect(resolveFinding(db, lockA.runId, findings[0]!.id, "confirmed")).toBe(true);
    expect(resolveFinding(db, lockA.runId, findings[1]!.id, "rejected")).toBe(true);

    const hit = getHitRate(db);
    expect(hit.confirmed).toBe(1);
    expect(hit.total).toBe(2);
  });
});

describe("queryPriorFindings", () => {
  test("returns successful prior runs but excludes the target week and earlier-than-window rows", () => {
    const old = acquireLock(db, "2025-12-28", "claude-sonnet-4-6");
    persistFindings(db, old.runId, [sampleFinding({ finding_type: "old_one" })]);
    old.release("success");

    const lockA = acquireLock(db, "2026-04-19", "claude-sonnet-4-6");
    persistFindings(db, lockA.runId, [sampleFinding({ finding_type: "prior_one" })]);
    lockA.release("success");

    const target = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    persistFindings(db, target.runId, [sampleFinding({ finding_type: "current_one" })]);

    const prior = queryPriorFindings(db, "2026-04-26", 8);
    expect(prior.map((f) => f.finding_type)).toEqual(["prior_one"]);
  });
});

describe("queryLastRunFindings", () => {
  test("returns the latest successful run's findings", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    persistFindings(db, lock.runId, [sampleFinding(), sampleFinding({ finding_type: "two" })]);
    lock.release("success");

    const result = queryLastRunFindings(db);
    expect(result.run?.id).toBe(lock.runId);
    expect(result.findings).toHaveLength(2);
  });
});
