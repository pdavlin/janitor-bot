/**
 * Tests for postFindingReplies.
 *
 * Stubs globalThis.fetch to capture chat.postMessage and reactions.add calls
 * so the test exercises the full flow (post + record + seed) against an
 * in-memory SQLite DB without any real network traffic.
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../../storage/db";
import { acquireLock } from "../lock";
import { persistFindings } from "../findings-store";
import {
  postFindingReplies,
  renderFindingForReply,
} from "../post-finding-replies";
import type { Finding } from "../types";
import type { Logger } from "../../../logger";

function silentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

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

let db: Database;
let originalFetch: typeof fetch;
let postCalls: Array<{ method: string; body: Record<string, unknown> }>;
let postCounter: number;
let postFailureForIndex: number | null;

function mountFetch(): void {
  postCalls = [];
  postCounter = 0;
  postFailureForIndex = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes("/chat.postMessage")) {
      const callIndex = postCounter++;
      postCalls.push({ method: "chat.postMessage", body });
      if (postFailureForIndex !== null && callIndex === postFailureForIndex) {
        return new Response(
          JSON.stringify({ ok: false, error: "channel_not_found" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const ts = `1700000${String(callIndex).padStart(3, "0")}.000100`;
      return new Response(
        JSON.stringify({ ok: true, channel: body.channel ?? "C1", ts }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/reactions.add")) {
      postCalls.push({ method: "reactions.add", body });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  db = createDatabase(":memory:");
  mountFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  db.close();
});

describe("renderFindingForReply", () => {
  test("renders the standard 3-line shape", () => {
    const text = renderFindingForReply(sampleFinding());
    expect(text).toContain("[watch, moderate]");
    expect(text).toContain("Channel pushed back");
    expect(text).toContain("Area: ranking.ts:target_base_scores · 4 plays");
    expect(text).toContain(":white_check_mark:");
    expect(text).toContain(":x:");
  });

  test("renders long descriptions in full (no truncation)", () => {
    const long = "x".repeat(500);
    const text = renderFindingForReply(sampleFinding({ description: long }));
    const firstLine = text.split("\n")[0]!;
    expect(firstLine).toContain(long);
    expect(firstLine.endsWith("…")).toBe(false);
  });
});

describe("postFindingReplies", () => {
  test("posts each finding, records ts, seeds reactions", async () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    const findings = [
      sampleFinding({ finding_type: "f1" }),
      sampleFinding({ finding_type: "f2" }),
    ];
    const ids = persistFindings(db, lock.runId, findings);

    const results = await postFindingReplies(
      db,
      { botToken: "xoxb-test", channelId: "C1" },
      { channel: "C1", ts: "100.000", runId: lock.runId },
      findings,
      ids,
      silentLogger(),
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);

    const rows = db
      .prepare(
        `SELECT run_id, finding_id, channel, ts, parent_ts FROM slack_finding_messages ORDER BY finding_id ASC;`,
      )
      .all() as Array<{
        run_id: number;
        finding_id: number;
        channel: string;
        ts: string;
        parent_ts: string;
      }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      run_id: lock.runId,
      finding_id: ids[0],
      channel: "C1",
      parent_ts: "100.000",
    });

    const postCount = postCalls.filter((c) => c.method === "chat.postMessage").length;
    const reactCount = postCalls.filter((c) => c.method === "reactions.add").length;
    expect(postCount).toBe(2);
    // 2 findings * 2 seed reactions each = 4 reactions.add calls
    expect(reactCount).toBe(4);

    const reactionNames = postCalls
      .filter((c) => c.method === "reactions.add")
      .map((c) => c.body.name);
    expect(reactionNames.filter((n) => n === "white_check_mark")).toHaveLength(2);
    expect(reactionNames.filter((n) => n === "x")).toHaveLength(2);
  });

  test("uses thread_ts equal to parent ts on every post", async () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    const findings = [sampleFinding()];
    const ids = persistFindings(db, lock.runId, findings);

    await postFindingReplies(
      db,
      { botToken: "xoxb-test", channelId: "C1" },
      { channel: "C1", ts: "DIGEST.TS", runId: lock.runId },
      findings,
      ids,
      silentLogger(),
    );

    const post = postCalls.find((c) => c.method === "chat.postMessage");
    expect(post?.body.thread_ts).toBe("DIGEST.TS");
  });

  test("isolates per-finding failures: one fails, others succeed", async () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    const findings = [
      sampleFinding({ finding_type: "f1" }),
      sampleFinding({ finding_type: "f2" }),
      sampleFinding({ finding_type: "f3" }),
    ];
    const ids = persistFindings(db, lock.runId, findings);

    // Cause the second post (index 1) to return ok:false.
    postFailureForIndex = 1;

    const results = await postFindingReplies(
      db,
      { botToken: "xoxb-test", channelId: "C1" },
      { channel: "C1", ts: "100.000", runId: lock.runId },
      findings,
      ids,
      silentLogger(),
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[2]?.ok).toBe(true);

    const rows = db
      .prepare(`SELECT finding_id FROM slack_finding_messages ORDER BY finding_id ASC;`)
      .all() as { finding_id: number }[];
    expect(rows.map((r) => r.finding_id)).toEqual([ids[0], ids[2]]);
  });

  test("throws when findings and findingIds lengths differ", async () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    await expect(
      postFindingReplies(
        db,
        { botToken: "xoxb-test", channelId: "C1" },
        { channel: "C1", ts: "100.000", runId: lock.runId },
        [sampleFinding(), sampleFinding()],
        [1],
        silentLogger(),
      ),
    ).rejects.toThrow();
  });

  test("empty findings is a no-op that returns []", async () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-6");
    const results = await postFindingReplies(
      db,
      { botToken: "xoxb-test", channelId: "C1" },
      { channel: "C1", ts: "100.000", runId: lock.runId },
      [],
      [],
      silentLogger(),
    );
    expect(results).toEqual([]);
    expect(postCalls).toHaveLength(0);
  });
});
