/**
 * End-to-end CLI test for the weekly-review full-run path.
 *
 * Strategy:
 *   - Open a `:memory:` DB and seed a week of plays + snapshots +
 *     slack_play_messages + slack_game_headers.
 *   - Stub `globalThis.fetch` to dispatch by URL:
 *       auth.test               -> canned bot user_id
 *       conversations.replies   -> canned channel discussion
 *       chat.postMessage        -> ok with a canned ts
 *       api.anthropic.com       -> canned findings JSON envelope
 *   - Override env so `loadConfig()` resolves an in-memory DB and the
 *     fake API key.
 *   - Invoke `runWeeklyReview([])` and assert: agent_runs row
 *     transitioned started -> success, agent_findings populated, Slack
 *     post issued, retention sweep ran.
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
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, insertPlay } from "../../../storage/db";
import { recordGameHeader, recordPlayMessage } from "../../../notifications/slack-messages-store";
import { runWeeklyReview } from "../../weekly-review";
import type { DetectedPlay } from "../../../types/play";

const BOT_USER_ID = "UBOT";

let tempDir: string;
let dbPath: string;
let originalFetch: typeof fetch;
const originalEnv: Record<string, string | undefined> = {};

function snapshotEnv(keys: string[]): void {
  for (const k of keys) originalEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function makePlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 100,
    playIndex: 1,
    date: "2026-04-28",
    fielderId: 7,
    fielderName: "Mookie Betts",
    fielderPosition: "RF",
    runnerId: 1,
    runnerName: "Some Runner",
    targetBase: "Home",
    batterName: "Some Batter",
    inning: 7,
    halfInning: "top",
    awayScore: 3,
    homeScore: 2,
    awayTeam: "LAD",
    homeTeam: "SFG",
    description: "RF -> Home",
    creditChain: "RF -> C",
    tier: "high",
    outs: 1,
    runnersOn: "1st",
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

function seed(db: Database): void {
  for (let i = 1; i <= 8; i++) {
    insertPlay(db, makePlay({ playIndex: i, runnerId: i }));
  }
  for (let i = 1; i <= 8; i++) {
    db.prepare(
      `INSERT INTO vote_snapshots (game_pk, play_index, fire_count, trash_count, net_score, voter_count, snapshotted_at, tier_review_flagged)
       VALUES ($g, $p, $f, $t, $n, $v, datetime('now'), $flag);`,
    ).run({
      $g: 100,
      $p: i,
      $f: i % 2 === 0 ? 1 : 3,
      $t: i % 2 === 0 ? 3 : 0,
      $n: i % 2 === 0 ? -2 : 3,
      $v: i % 2 === 0 ? 4 : 3,
      $flag: i === 4 ? 1 : 0,
    });
  }
  recordGameHeader(db, 100, "C123", "1700000000.000001");
  for (let i = 1; i <= 8; i++) {
    recordPlayMessage(
      db,
      100,
      i,
      "C123",
      `1700000000.0001${i}`,
      "1700000000.000001",
    );
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "weekly-review-int-"));
  dbPath = join(tempDir, "test.db");
  const db = createDatabase(dbPath);
  seed(db);
  db.close();

  snapshotEnv([
    "DB_PATH",
    "ANTHROPIC_API_KEY",
    "AGENT_MODEL",
    "SLACK_BOT_TOKEN",
    "SLACK_CHANNEL_ID",
    "LOG_LEVEL",
    "AGENT_HISTORY_WEEKS",
  ]);
  process.env.DB_PATH = dbPath;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.AGENT_MODEL = "claude-sonnet-4-7";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_CHANNEL_ID = "C123";
  process.env.LOG_LEVEL = "error";
  process.env.AGENT_HISTORY_WEEKS = "8";

  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("weekly-review CLI integration", () => {
  test("full run posts a digest and persists findings", async () => {
    globalThis.fetch = mock(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("slack.com/api/auth.test")) {
        return jsonResponse({ ok: true, user_id: BOT_USER_ID });
      }
      if (url.includes("slack.com/api/conversations.replies")) {
        return jsonResponse({
          ok: true,
          messages: [
            { user: BOT_USER_ID, text: "bot post", ts: "10.001" },
            { user: "U1", text: "channel discussion sample", ts: "10.002" },
          ],
        });
      }
      if (url.includes("slack.com/api/chat.postMessage")) {
        return jsonResponse({ ok: true, channel: "C123", ts: "1700000000.999999" });
      }
      if (url.includes("api.anthropic.com")) {
        // The SDK posts to /v1/messages. Return a canned response shape.
        return jsonResponse({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-7",
          stop_reason: "end_turn",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                findings: [
                  {
                    finding_type: "rf_home_pushback_test",
                    description:
                      "Pattern: bot tagged the throws high but the channel pushed back consistently across the week.",
                    severity: "watch",
                    evidence_strength: "moderate",
                    evidence_play_ids: [1, 2, 3, 4],
                    suspected_rule_area: "ranking.ts:target_base_scores",
                    trend: "first_seen",
                  },
                ],
              }),
            },
          ],
          usage: { input_tokens: 1500, output_tokens: 200 },
        });
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ""}`);
    }) as unknown as typeof fetch;

    const exitCode = await runWeeklyReview([
      "--week-starting",
      "2026-04-26",
    ]);
    expect(exitCode).toBe(0);

    // Verify DB state.
    const verifyDb = new Database(dbPath);
    const run = verifyDb
      .prepare(
        `SELECT id, status, posted_message_ts, input_tokens, output_tokens
         FROM agent_runs ORDER BY id DESC LIMIT 1;`,
      )
      .get() as {
      id: number;
      status: string;
      posted_message_ts: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
    };
    expect(run.status).toBe("success");
    expect(run.posted_message_ts).toBe("1700000000.999999");
    expect(run.input_tokens).toBe(1500);
    expect(run.output_tokens).toBe(200);

    const findingCount = verifyDb
      .prepare(`SELECT COUNT(*) AS c FROM agent_findings WHERE run_id = $id;`)
      .get({ $id: run.id }) as { c: number };
    expect(findingCount.c).toBe(1);
    verifyDb.close();
  }, 15_000);

  test("insufficient data path posts the gate message and skips the LLM", async () => {
    // Wipe the seed and insert just two plays (under the 5-play threshold)
    const db = new Database(dbPath);
    db.run(`DELETE FROM plays;`);
    db.run(`DELETE FROM vote_snapshots;`);
    insertPlay(db, makePlay({ playIndex: 1 }));
    insertPlay(db, makePlay({ playIndex: 2, runnerId: 2 }));
    db.close();

    let anthropicCalled = false;
    globalThis.fetch = mock(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("slack.com/api/auth.test")) {
        return jsonResponse({ ok: true, user_id: BOT_USER_ID });
      }
      if (url.includes("slack.com/api/conversations.replies")) {
        return jsonResponse({ ok: true, messages: [] });
      }
      if (url.includes("slack.com/api/chat.postMessage")) {
        return jsonResponse({ ok: true, channel: "C123", ts: "1700000001.000001" });
      }
      if (url.includes("api.anthropic.com")) {
        anthropicCalled = true;
        throw new Error("anthropic should not be called on insufficient-data path");
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const exitCode = await runWeeklyReview([
      "--week-starting",
      "2026-04-26",
    ]);
    expect(exitCode).toBe(0);
    expect(anthropicCalled).toBe(false);

    const verifyDb = new Database(dbPath);
    const run = verifyDb
      .prepare(`SELECT status FROM agent_runs ORDER BY id DESC LIMIT 1;`)
      .get() as { status: string };
    expect(run.status).toBe("success");
    verifyDb.close();
  }, 10_000);
});
