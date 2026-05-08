import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { createLogger } from "../../../logger";
import {
  notifyOperator,
  renderNotification,
  type NotificationBody,
} from "../notify-operator";

const silentLogger = createLogger("error");
const SLACK_CONFIG = { botToken: "xoxb-test", channelId: "C123", webhookUrl: undefined };
const OPERATOR_ID = "U07ABC1234";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const dumpBody: NotificationBody = {
  kind: "dump_captured",
  ctx: {
    weekStarting: "2026-04-26",
    weekEnding: "2026-05-02",
    runId: 42,
    model: "claude-sonnet-4-6",
    dumpPath: "/home/exedev/janitor-bot/weekly-review-dumps/x.json",
    acceptedCount: 5,
    rejectedCount: 1,
    estimatedCostUsd: 0.0234,
  },
};

const concurrentBody: NotificationBody = {
  kind: "concurrent_run_blocked",
  ctx: { weekStarting: "2026-04-26", blockingRunId: 41 },
};

const sweepBody: NotificationBody = {
  kind: "retention_sweep_failed",
  ctx: { runId: 42, errorMessage: "DB locked" },
};

const rejectedBody: NotificationBody = {
  kind: "all_findings_rejected",
  ctx: {
    runId: 42,
    weekStarting: "2026-04-26",
    rejectionsByReason: { quote: 3, mention: 1, substring: 2 },
    totalRejected: 6,
  },
};

describe("renderNotification", () => {
  test("dump_captured includes window, run id, path, counts, cost", () => {
    const text = renderNotification(dumpBody);
    expect(text).toContain(":floppy_disk:");
    expect(text).toContain("2026-04-26 to 2026-05-02");
    expect(text).toContain("Run id: 42");
    expect(text).toContain("claude-sonnet-4-6");
    expect(text).toContain("5 accepted, 1 rejected");
    expect(text).toContain("$0.0234");
    expect(text).toContain("/home/exedev/janitor-bot/weekly-review-dumps/x.json");
  });

  test("concurrent_run_blocked names the blocking run id when present", () => {
    expect(renderNotification(concurrentBody)).toContain("Blocked by run id 41");
  });

  test("concurrent_run_blocked falls back to generic wording when blockingRunId is null", () => {
    const text = renderNotification({
      kind: "concurrent_run_blocked",
      ctx: { weekStarting: "2026-04-26", blockingRunId: null },
    });
    expect(text).toContain("Blocked by an in-progress run");
    expect(text).not.toContain("Blocked by run id");
  });

  test("retention_sweep_failed truncates error messages over 280 chars", () => {
    const long = "x".repeat(400);
    const text = renderNotification({
      kind: "retention_sweep_failed",
      ctx: { runId: 1, errorMessage: long },
    });
    expect(text).toContain("…");
    expect(text.includes("x".repeat(400))).toBe(false);
  });

  test("retention_sweep_failed leaves short messages alone", () => {
    expect(renderNotification(sweepBody)).toContain("Error: DB locked");
  });

  test("all_findings_rejected groups + sorts reasons", () => {
    const text = renderNotification(rejectedBody);
    expect(text).toContain("By reason: mention: 1, quote: 3, substring: 2");
    expect(text).toContain("6 LLM findings failed validation");
  });

  test("renderNotification body never contains transcript-leakage signals", () => {
    for (const body of [dumpBody, concurrentBody, sweepBody, rejectedBody]) {
      const text = renderNotification(body);
      expect(text).not.toMatch(/<@/);
      expect(text).not.toMatch(/<#/);
      // Backticks, smart quotes, and Slack mention syntax must not appear.
      expect(text).not.toMatch(/[“”‘’]/);
    }
  });
});

describe("notifyOperator", () => {
  function mockSlack(handler: (body: Record<string, unknown>) => Response): {
    fetched: { url: string; body: Record<string, unknown> }[];
  } {
    const fetched: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = mock(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const raw = init?.body ? init.body.toString() : "{}";
      const body = JSON.parse(raw) as Record<string, unknown>;
      fetched.push({ url, body });
      return handler(body);
    }) as unknown as typeof fetch;
    return { fetched };
  }

  test("happy path posts to chat.postMessage with channel=userId", async () => {
    const { fetched } = mockSlack(() =>
      new Response(JSON.stringify({ ok: true, ts: "1.001" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const ok = await notifyOperator(SLACK_CONFIG, OPERATOR_ID, dumpBody, silentLogger);
    expect(ok).toBe(true);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.url).toContain("chat.postMessage");
    expect(fetched[0]!.body.channel).toBe(OPERATOR_ID);
    expect(typeof fetched[0]!.body.text).toBe("string");
  });

  test("returns false on Slack non-ok without throwing", async () => {
    mockSlack(() =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const ok = await notifyOperator(SLACK_CONFIG, OPERATOR_ID, dumpBody, silentLogger);
    expect(ok).toBe(false);
  });

  test("returns false when fetch throws", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const ok = await notifyOperator(SLACK_CONFIG, OPERATOR_ID, dumpBody, silentLogger);
    expect(ok).toBe(false);
  });

  test("short-circuits without a fetch call when userId is missing", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await notifyOperator(SLACK_CONFIG, undefined, dumpBody, silentLogger);
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  test("short-circuits without a fetch call when botToken is missing", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await notifyOperator(
      { botToken: undefined, channelId: undefined, webhookUrl: undefined },
      OPERATOR_ID,
      dumpBody,
      silentLogger,
    );
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });
});
