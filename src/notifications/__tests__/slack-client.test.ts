/**
 * Tests for slack-client transport: bot-token API + webhook fallback.
 *
 * `globalThis.fetch` is mocked per-test so no real network traffic happens.
 * The webhook fallback path uses Bun.sleep on retry; tests that exercise
 * retries take a few seconds — keep counts small.
 */

import { test, expect, describe, afterEach, mock } from "bun:test";
import {
  determineSlackMode,
  postMessage,
  updateMessage,
  postThreadReply,
  seedVoteReactions,
  sendGameNotifications,
  sendWebhook,
} from "../slack-client";
import type { GameFinalScore } from "../slack-formatter";
import type { Logger } from "../../logger";
import type { DetectedPlay } from "../../types/play";

function makeSilentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

const originalFetch = globalThis.fetch;

function mockFetch(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  const mocked = Object.assign(mock(fn), {
    preconnect: mock((_url: string | URL) => {}),
  });
  globalThis.fetch = mocked;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("determineSlackMode", () => {
  test("bot_token when both token and channel set", () => {
    expect(
      determineSlackMode({ botToken: "xoxb-x", channelId: "C1" }),
    ).toBe("bot_token");
  });

  test("bot_token wins over webhook when both configured", () => {
    expect(
      determineSlackMode({
        botToken: "xoxb-x",
        channelId: "C1",
        webhookUrl: "https://hooks.slack.com/x",
      }),
    ).toBe("bot_token");
  });

  test("webhook when only webhook url set", () => {
    expect(determineSlackMode({ webhookUrl: "https://hooks.slack.com/x" })).toBe(
      "webhook",
    );
  });

  test("disabled when nothing set", () => {
    expect(determineSlackMode({})).toBe("disabled");
  });

  test("disabled when only botToken (no channel)", () => {
    expect(determineSlackMode({ botToken: "xoxb-x" })).toBe("disabled");
  });
});

describe("postMessage (bot-token)", () => {
  test("returns channel + ts on success", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, channel: "C1", ts: "1234.567" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const logger = makeSilentLogger();
    const result = await postMessage(
      { botToken: "xoxb-x", channelId: "C1" },
      { blocks: [] },
      logger,
    );

    expect(result).toEqual({ ok: true, channel: "C1", ts: "1234.567" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("returns null on non-ok api response", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, error: "channel_not_found" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const logger = makeSilentLogger();
    const result = await postMessage(
      { botToken: "xoxb-x", channelId: "C1" },
      { blocks: [] },
      logger,
    );

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  test("returns null on 429 rate limit", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
      ),
    );

    const logger = makeSilentLogger();
    const result = await postMessage(
      { botToken: "xoxb-x", channelId: "C1" },
      { blocks: [] },
      logger,
    );

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  test("includes Authorization header and channel in body", async () => {
    let captured: { headers?: Headers; body?: unknown } = {};
    mockFetch((_url, init) => {
      captured = {
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }),
          { status: 200 },
        ),
      );
    });

    await postMessage(
      { botToken: "xoxb-secret", channelId: "C1" },
      { blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }] },
      makeSilentLogger(),
    );

    expect(captured.headers?.get("authorization")).toBe("Bearer xoxb-secret");
    expect(captured.body).toMatchObject({ channel: "C1" });
  });
});

describe("postMessage (webhook fallback)", () => {
  test("posts to webhook url and returns null", async () => {
    let calledUrl: string | undefined;
    mockFetch((url) => {
      calledUrl = String(url);
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const result = await postMessage(
      { webhookUrl: "https://hooks.slack.com/services/x" },
      { blocks: [] },
      makeSilentLogger(),
    );

    expect(result).toBeNull();
    expect(calledUrl).toBe("https://hooks.slack.com/services/x");
  });

  test("disabled mode returns null without making a request", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const result = await postMessage({}, { blocks: [] }, makeSilentLogger());
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("updateMessage", () => {
  test("returns true when chat.update succeeds", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    );

    const ok = await updateMessage(
      { botToken: "xoxb-x", channelId: "C1" },
      "C1",
      "1234.567",
      { blocks: [] },
      makeSilentLogger(),
    );

    expect(ok).toBe(true);
  });

  test("returns false and skips fetch when no bot token", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const ok = await updateMessage(
      {},
      "C1",
      "1.2",
      { blocks: [] },
      makeSilentLogger(),
    );

    expect(ok).toBe(false);
    expect(calls).toBe(0);
  });

  test("returns false on non-ok api response", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, error: "message_not_found" }),
          { status: 200 },
        ),
      ),
    );

    const ok = await updateMessage(
      { botToken: "xoxb-x" },
      "C1",
      "1.2",
      { blocks: [] },
      makeSilentLogger(),
    );

    expect(ok).toBe(false);
  });
});

describe("postThreadReply", () => {
  test("includes thread_ts in body and returns true on success", async () => {
    let captured: { body?: unknown } = {};
    mockFetch((_url, init) => {
      captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    });

    const ok = await postThreadReply(
      { botToken: "xoxb-x", channelId: "C1" },
      "C1",
      "1234.567",
      { blocks: [] },
      makeSilentLogger(),
    );

    expect(ok).toBe(true);
    expect(captured.body).toMatchObject({
      channel: "C1",
      thread_ts: "1234.567",
    });
  });

  test("returns false without bot token", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const ok = await postThreadReply(
      {},
      "C1",
      "1.2",
      { blocks: [] },
      makeSilentLogger(),
    );

    expect(ok).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("seedVoteReactions", () => {
  test("calls reactions.add for both fire and wastebasket in order", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    mockFetch((input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(init!.body as string),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    });

    await seedVoteReactions(
      { botToken: "xoxb-x", channelId: "C1" },
      "C1",
      "1234.5678",
      makeSilentLogger(),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://slack.com/api/reactions.add");
    expect(calls[0].body).toEqual({
      channel: "C1",
      timestamp: "1234.5678",
      name: "fire",
    });
    expect(calls[1].body).toEqual({
      channel: "C1",
      timestamp: "1234.5678",
      name: "wastebasket",
    });
  });

  test("logs and continues when one reaction fails", async () => {
    let callCount = 0;
    mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: false, error: "already_reacted" }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    });

    const logger = makeSilentLogger();
    await seedVoteReactions(
      { botToken: "xoxb-x", channelId: "C1" },
      "C1",
      "1234.5678",
      logger,
    );

    expect(callCount).toBe(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("skips entirely without a bot token", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    await seedVoteReactions({}, "C1", "1234.5678", makeSilentLogger());

    expect(calls).toBe(0);
  });
});

function makeMockPlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 745433,
    playIndex: 42,
    date: "2024-04-09",
    fielderId: 676962,
    fielderName: "Cody Bellinger",
    fielderPosition: "CF",
    runnerId: 123456,
    runnerName: "Some Runner",
    targetBase: "3B",
    batterName: "Some Batter",
    inning: 7,
    halfInning: "top",
    awayScore: 2,
    homeScore: 1,
    awayTeam: "CHC",
    homeTeam: "SD",
    description: "Bellinger throws out runner at third base",
    creditChain: "CF -> 3B",
    tier: "high",
    outs: 1,
    runnersOn: "1st, 2nd",
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

interface CapturedCall {
  url: string;
  body: Record<string, unknown> | undefined;
}

function mockFetchRecording(): {
  calls: CapturedCall[];
  setResponses: (responses: Response[]) => void;
} {
  const calls: CapturedCall[] = [];
  let queue: Response[] = [];
  const fn = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const response =
      queue.shift() ??
      new Response(JSON.stringify({ ok: true, channel: "C1", ts: "auto.0" }), {
        status: 200,
      });
    return Promise.resolve(response);
  };
  const mocked = Object.assign(mock(fn), {
    preconnect: mock((_url: string | URL) => {}),
  });
  globalThis.fetch = mocked;
  return {
    calls,
    setResponses(responses) {
      queue = responses;
    },
  };
}

describe("sendGameNotifications (bot-token mode)", () => {
  test("3-play game produces 1 header post + 3 thread replies in order", async () => {
    const recorder = mockFetchRecording();
    // Queue chat.postMessage responses; reactions.add calls fall through to
    // the recorder's default `ok:true` response.
    recorder.setResponses([
      new Response(
        JSON.stringify({ ok: true, channel: "C1", ts: "header.ts" }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({ ok: true, channel: "C1", ts: "play.1" }),
        { status: 200 },
      ),
      // Two reactions.add slots for play 1 (any ok response is fine)
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      new Response(
        JSON.stringify({ ok: true, channel: "C1", ts: "play.2" }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      new Response(
        JSON.stringify({ ok: true, channel: "C1", ts: "play.3" }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);

    const plays = [
      makeMockPlay({ playIndex: 1 }),
      makeMockPlay({ playIndex: 2 }),
      makeMockPlay({ playIndex: 3 }),
    ];
    const scores = new Map<number, GameFinalScore>([
      [745433, { away: 2, home: 1 }],
    ]);

    const results = await sendGameNotifications(
      plays,
      scores,
      { botToken: "xoxb-x", channelId: "C1" },
      makeSilentLogger(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].header?.ts).toBe("header.ts");
    expect(results[0].plays.map((p) => p.result?.ts)).toEqual([
      "play.1",
      "play.2",
      "play.3",
    ]);

    // 1 header + 3 plays + (2 reactions x 3 plays) = 10 calls
    expect(recorder.calls).toHaveLength(10);

    const postMessageCalls = recorder.calls.filter((c) =>
      c.url.endsWith("/chat.postMessage"),
    );
    const reactionCalls = recorder.calls.filter((c) =>
      c.url.endsWith("/reactions.add"),
    );
    expect(postMessageCalls).toHaveLength(4);
    expect(reactionCalls).toHaveLength(6);

    // Header has no thread_ts; the three replies do.
    expect(postMessageCalls[0].body?.thread_ts).toBeUndefined();
    for (let i = 1; i <= 3; i++) {
      expect(postMessageCalls[i].body).toMatchObject({
        channel: "C1",
        thread_ts: "header.ts",
      });
    }

    // Each play reply gets seeded with :fire: then :wastebasket: in order.
    for (const playTs of ["play.1", "play.2", "play.3"]) {
      const seeds = reactionCalls.filter(
        (c) => (c.body as { timestamp?: string }).timestamp === playTs,
      );
      expect(seeds.map((c) => (c.body as { name: string }).name)).toEqual([
        "fire",
        "wastebasket",
      ]);
    }
  });

  test("header failure short-circuits play sends for that game", async () => {
    const recorder = mockFetchRecording();
    recorder.setResponses([
      new Response(
        JSON.stringify({ ok: false, error: "channel_not_found" }),
        { status: 200 },
      ),
    ]);

    const plays = [makeMockPlay({ playIndex: 1 }), makeMockPlay({ playIndex: 2 })];
    const scores = new Map<number, GameFinalScore>([
      [745433, { away: 0, home: 0 }],
    ]);
    const logger = makeSilentLogger();

    const results = await sendGameNotifications(
      plays,
      scores,
      { botToken: "xoxb-x", channelId: "C1" },
      logger,
    );

    expect(recorder.calls).toHaveLength(1);
    expect(results[0].header).toBeNull();
    expect(results[0].plays).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("missing score in map defaults to 0-0 without throwing", async () => {
    const recorder = mockFetchRecording();
    recorder.setResponses([
      new Response(
        JSON.stringify({ ok: true, channel: "C1", ts: "header.ts" }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({ ok: true, channel: "C1", ts: "play.1" }),
        { status: 200 },
      ),
    ]);

    const plays = [makeMockPlay({ playIndex: 1 })];
    const results = await sendGameNotifications(
      plays,
      new Map<number, GameFinalScore>(),
      { botToken: "xoxb-x", channelId: "C1" },
      makeSilentLogger(),
    );

    expect(results[0].header?.ts).toBe("header.ts");
  });

  test("empty plays returns empty results without making any calls", async () => {
    const recorder = mockFetchRecording();
    const results = await sendGameNotifications(
      [],
      new Map<number, GameFinalScore>(),
      { botToken: "xoxb-x", channelId: "C1" },
      makeSilentLogger(),
    );
    expect(results).toEqual([]);
    expect(recorder.calls).toHaveLength(0);
  });
});

describe("sendGameNotifications (webhook fallback)", () => {
  test("posts a single combined message and skips thread replies", async () => {
    const recorder = mockFetchRecording();
    recorder.setResponses([new Response("ok", { status: 200 })]);

    const plays = [
      makeMockPlay({ playIndex: 1 }),
      makeMockPlay({ playIndex: 2 }),
    ];
    const results = await sendGameNotifications(
      plays,
      new Map<number, GameFinalScore>([[745433, { away: 0, home: 0 }]]),
      { webhookUrl: "https://hooks.slack.com/services/x" },
      makeSilentLogger(),
    );

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].url).toBe(
      "https://hooks.slack.com/services/x",
    );
    // Webhook mode reports header=null (no addressable ts) and play results
    // are uniformly null so callers can iterate without branching.
    expect(results[0].header).toBeNull();
    expect(results[0].plays).toHaveLength(2);
    expect(results[0].plays.every((p) => p.result === null)).toBe(true);
  });
});

describe("sendWebhook (legacy retry path)", () => {
  test("returns true on first 200", async () => {
    mockFetch(() =>
      Promise.resolve(new Response("ok", { status: 200 })),
    );

    const ok = await sendWebhook(
      "https://hooks.slack.com/test",
      { text: "hi" },
      makeSilentLogger(),
    );

    expect(ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("returns true on first success even if earlier attempts would fail", async () => {
    let callCount = 0;
    mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response("error", { status: 500 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const ok = await sendWebhook(
      "https://hooks.slack.com/test",
      { text: "hi" },
      makeSilentLogger(),
    );

    expect(ok).toBe(true);
    expect(callCount).toBe(2);
  });
});
