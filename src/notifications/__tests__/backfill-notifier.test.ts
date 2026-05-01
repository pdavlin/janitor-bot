/**
 * Tests for makeBackfillNotifier — the bridge between runBackfillCycle's
 * onSuccess hook and Slack chat.update / thread reply.
 *
 * Mocks globalThis.fetch and uses an in-memory SQLite database so the
 * notifier walks the real lookup → update → mark → reply path.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../storage/db";
import { recordSlackMessage } from "../slack-messages-store";
import { makeBackfillNotifier } from "../backfill-notifier";
import type { Logger } from "../../logger";
import type { DetectedPlay } from "../../types/play";
import type { BackfillSuccessEvent } from "../../daemon/backfill";

function makeSilentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  body: Record<string, unknown> | undefined;
}

function mockFetchRecording(): { calls: FetchCall[]; setResponses: (responses: Response[]) => void } {
  const calls: FetchCall[] = [];
  let queue: Response[] = [];
  const fn = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const response =
      queue.shift() ?? new Response(JSON.stringify({ ok: true }), { status: 200 });
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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makePlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
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
    playId: "uuid-1",
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("makeBackfillNotifier", () => {
  test("no slack message ref means no fetch is made", async () => {
    const recorder = mockFetchRecording();
    const logger = makeSilentLogger();
    const notifier = makeBackfillNotifier(
      db,
      { botToken: "xoxb-x", channelId: "C1" },
      logger,
    );

    insertPlay(db, makePlay());

    await notifier({
      gamePk: 745433,
      playIndex: 42,
      videoUrl: "https://example.com/v.mp4",
      videoTitle: "Watch",
    });

    expect(recorder.calls).toHaveLength(0);
  });

  test("with ref: posts chat.update then chat.postMessage thread reply", async () => {
    const recorder = mockFetchRecording();
    recorder.setResponses([
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const logger = makeSilentLogger();
    const config = { botToken: "xoxb-x", channelId: "C1" };
    const notifier = makeBackfillNotifier(db, config, logger);

    const play = makePlay({ videoUrl: "https://example.com/v.mp4" });
    insertPlay(db, play);
    recordSlackMessage(db, play.gamePk, "C1", "1700000000.000100");

    const event: BackfillSuccessEvent = {
      gamePk: play.gamePk,
      playIndex: play.playIndex,
      videoUrl: "https://example.com/v.mp4",
      videoTitle: "Watch",
    };

    await notifier(event);

    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[0].url).toBe("https://slack.com/api/chat.update");
    expect(recorder.calls[0].body).toMatchObject({
      channel: "C1",
      ts: "1700000000.000100",
    });
    expect(recorder.calls[1].url).toBe("https://slack.com/api/chat.postMessage");
    expect(recorder.calls[1].body).toMatchObject({
      channel: "C1",
      thread_ts: "1700000000.000100",
    });

    // last_updated_at should be stamped
    const row = db
      .prepare("SELECT last_updated_at FROM slack_messages WHERE game_pk = ?")
      .get(play.gamePk) as { last_updated_at: string | null };
    expect(row.last_updated_at).not.toBeNull();
  });

  test("chat.update failure skips the thread reply", async () => {
    const recorder = mockFetchRecording();
    recorder.setResponses([
      new Response(
        JSON.stringify({ ok: false, error: "message_not_found" }),
        { status: 200 },
      ),
    ]);
    const logger = makeSilentLogger();
    const notifier = makeBackfillNotifier(
      db,
      { botToken: "xoxb-x", channelId: "C1" },
      logger,
    );

    const play = makePlay();
    insertPlay(db, play);
    recordSlackMessage(db, play.gamePk, "C1", "1.0");

    await notifier({
      gamePk: play.gamePk,
      playIndex: play.playIndex,
      videoUrl: "https://example.com/v.mp4",
      videoTitle: "Watch",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].url).toBe("https://slack.com/api/chat.update");
    expect(logger.warn).toHaveBeenCalled();
  });

  test("concurrent calls for same gamePk serialize", async () => {
    const recorder = mockFetchRecording();
    const order: string[] = [];

    let resolveFirst: (v: Response) => void = () => {};
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });

    let callIdx = 0;
    globalThis.fetch = Object.assign(
      mock(
        (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          callIdx++;
          recorder.calls.push({
            url: String(input),
            body: init?.body ? JSON.parse(init.body as string) : undefined,
          });
          if (callIdx === 1) {
            order.push("first-update-start");
            return firstResponse.then((r) => {
              order.push("first-update-end");
              return r;
            });
          }
          if (callIdx === 2) {
            order.push("first-thread-start");
            return Promise.resolve(
              new Response(JSON.stringify({ ok: true }), { status: 200 }),
            ).then((r) => {
              order.push("first-thread-end");
              return r;
            });
          }
          if (callIdx === 3) {
            order.push("second-update-start");
            return Promise.resolve(
              new Response(JSON.stringify({ ok: true }), { status: 200 }),
            ).then((r) => {
              order.push("second-update-end");
              return r;
            });
          }
          order.push("second-thread-start");
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
          ).then((r) => {
            order.push("second-thread-end");
            return r;
          });
        },
      ),
      { preconnect: mock((_url: string | URL) => {}) },
    );

    const logger = makeSilentLogger();
    const notifier = makeBackfillNotifier(
      db,
      { botToken: "xoxb-x", channelId: "C1" },
      logger,
    );

    const play = makePlay();
    insertPlay(db, play);
    recordSlackMessage(db, play.gamePk, "C1", "1.0");

    const event: BackfillSuccessEvent = {
      gamePk: play.gamePk,
      playIndex: play.playIndex,
      videoUrl: "https://example.com/v.mp4",
      videoTitle: "Watch",
    };

    const p1 = notifier(event);
    const p2 = notifier(event);

    // p2 must not have started its first fetch until p1 finishes
    await Bun.sleep(20);
    expect(callIdx).toBe(1);

    resolveFirst(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await Promise.all([p1, p2]);

    // Order asserts the second invocation's update only began after the
    // first invocation's thread reply ended (full serialization).
    expect(order).toEqual([
      "first-update-start",
      "first-update-end",
      "first-thread-start",
      "first-thread-end",
      "second-update-start",
      "second-update-end",
      "second-thread-start",
      "second-thread-end",
    ]);
  });
});
