import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../../storage/db";
import { recordGameHeader } from "../../../notifications/slack-messages-store";
import { createLogger } from "../../../logger";
import { gather, totalVotes } from "../gather";
import type { DetectedPlay } from "../../../types/play";

const silentLogger = createLogger("error");
const SLACK_CONFIG = {
  botToken: "xoxb-test",
  channelId: "C123",
  webhookUrl: undefined,
};
const WINDOW = { weekStarting: "2026-04-26", weekEnding: "2026-05-02" };
const BOT_USER_ID = "UBOT";
const PRIOR_DIGEST_TS = "1700000000.000123";

let db: Database;
let originalFetch: typeof fetch;

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

function insertSnapshot(
  gamePk: number,
  playIndex: number,
  fire: number,
  trash: number,
): void {
  db.prepare(
    `INSERT INTO vote_snapshots (game_pk, play_index, fire_count, trash_count, net_score, voter_count, snapshotted_at, tier_review_flagged)
     VALUES ($g, $p, $f, $t, $n, $v, datetime('now'), 0);`,
  ).run({
    $g: gamePk,
    $p: playIndex,
    $f: fire,
    $t: trash,
    $n: fire - trash,
    $v: fire + trash,
  });
}

function fakeReplies(messages: { user?: string; text: string; ts: string; thread_ts?: string }[]): Response {
  return new Response(JSON.stringify({ ok: true, messages }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeAuthTest(): Response {
  return new Response(JSON.stringify({ ok: true, user_id: BOT_USER_ID }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  db = createDatabase(":memory:");
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("gather", () => {
  test("returns empty data for a week with no plays", async () => {
    globalThis.fetch = mock(async () => fakeAuthTest()) as unknown as typeof fetch;
    const data = await gather(db, SLACK_CONFIG, WINDOW, 8, silentLogger);
    expect(data.plays).toHaveLength(0);
    expect(data.snapshots).toHaveLength(0);
    expect(data.transcript.games).toHaveLength(0);
  });

  test("aggregates plays + snapshots inside the window and skips out-of-window rows", async () => {
    insertPlay(db, makePlay({ playIndex: 1 }));
    insertPlay(db, makePlay({ playIndex: 2, date: "2026-05-02" }));
    insertPlay(db, makePlay({ playIndex: 3, date: "2026-04-25" })); // out
    insertSnapshot(100, 1, 3, 0);
    insertSnapshot(100, 2, 1, 4);
    insertSnapshot(100, 3, 9, 0);

    globalThis.fetch = mock(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("auth.test")) return fakeAuthTest();
      if (url.includes("conversations.replies")) return fakeReplies([]);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const data = await gather(db, SLACK_CONFIG, WINDOW, 8, silentLogger);
    expect(data.plays.map((p) => p.playIndex)).toEqual([1, 2]);
    expect(data.snapshots.map((s) => s.playIndex)).toEqual([1, 2]);
    expect(totalVotes(data)).toBe(8);
  });

  test("filters bot messages and digest ts, routes digest replies to channelCorrections", async () => {
    insertPlay(db, makePlay({ playIndex: 1 }));
    recordGameHeader(db, 100, "C123", "1700000001.000001");
    db.run(
      `INSERT INTO agent_runs (week_starting, model, started_at, status, posted_message_ts)
       VALUES ('2026-04-19', 'claude-sonnet-4-7', datetime('now'), 'success', '${PRIOR_DIGEST_TS}');`,
    );

    globalThis.fetch = mock(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("auth.test")) return fakeAuthTest();
      if (url.includes("conversations.replies")) {
        return fakeReplies([
          { user: BOT_USER_ID, text: "bot post — should be filtered", ts: "10.001" },
          { user: "U1", text: "wow great catch", ts: "10.002" },
          { user: "U1", text: "nope", ts: PRIOR_DIGEST_TS },
          { user: "U2", text: "well actually that was a mishit", ts: "10.003", thread_ts: PRIOR_DIGEST_TS },
        ]);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const data = await gather(db, SLACK_CONFIG, WINDOW, 8, silentLogger);

    expect(data.transcript.games).toHaveLength(1);
    const messages = data.transcript.games[0]!.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("wow great catch");

    expect(data.channelCorrections).toHaveLength(1);
    expect(data.channelCorrections[0]!.text).toBe(
      "well actually that was a mishit",
    );
  });

  test("truncates transcripts that exceed the per-game token cap", async () => {
    insertPlay(db, makePlay({ playIndex: 1 }));
    recordGameHeader(db, 100, "C123", "1700000001.000001");

    const longText = "x".repeat(4000); // ~1000 tokens each
    const messages = Array.from({ length: 5 }, (_, i) => ({
      user: "U1",
      text: longText,
      ts: `10.${i + 1}`,
    }));

    globalThis.fetch = mock(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("auth.test")) return fakeAuthTest();
      if (url.includes("conversations.replies")) return fakeReplies(messages);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const data = await gather(db, SLACK_CONFIG, WINDOW, 8, silentLogger);
    expect(data.transcript.games[0]!.truncated).toBe(true);
    expect(data.transcript.games[0]!.messages.length).toBeLessThan(5);
    expect(data.transcript.games[0]!.messages.length).toBeGreaterThan(0);
  });

  test("tolerates missing play_tags table (phase 3 not landed)", async () => {
    insertPlay(db, makePlay({ playIndex: 1 }));
    insertSnapshot(100, 1, 1, 0);

    globalThis.fetch = mock(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("auth.test")) return fakeAuthTest();
      if (url.includes("conversations.replies")) return fakeReplies([]);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const data = await gather(db, SLACK_CONFIG, WINDOW, 8, silentLogger);
    expect(data.tags).toEqual([]);
  });
});
