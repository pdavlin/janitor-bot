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
  sendWebhook,
} from "../slack-client";
import type { Logger } from "../../logger";

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
