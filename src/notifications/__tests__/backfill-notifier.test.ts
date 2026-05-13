/**
 * Tests for makeBackfillNotifier — the bridge between runBackfillCycle's
 * onSuccess hook and the Slack per-play chat.update + thread reply.
 *
 * Mocks globalThis.fetch and uses an in-memory SQLite database so the
 * notifier walks the real lookup → update → mark → reply path.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../storage/db";
import {
  recordGameHeader,
  recordPlayMessage,
} from "../slack-messages-store";
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

function mockFetchRecording(): {
  calls: FetchCall[];
  setResponses: (responses: Response[]) => void;
} {
  const calls: FetchCall[] = [];
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
    isOverturned: false,
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
  test("no play message ref means no fetch is made", async () => {
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

  test("with ref: chat.update on play ts, then thread reply on parent ts", async () => {
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
    recordGameHeader(db, play.gamePk, "C1", "header.ts");
    recordPlayMessage(db, play.gamePk, play.playIndex, "C1", "play.ts", "header.ts");

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
      ts: "play.ts",
    });
    expect(recorder.calls[1].url).toBe("https://slack.com/api/chat.postMessage");
    expect(recorder.calls[1].body).toMatchObject({
      channel: "C1",
      thread_ts: "header.ts",
    });

    const row = db
      .prepare(
        "SELECT last_updated_at FROM slack_play_messages WHERE game_pk = ? AND play_index = ?",
      )
      .get(play.gamePk, play.playIndex) as { last_updated_at: string | null };
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
    recordGameHeader(db, play.gamePk, "C1", "header.ts");
    recordPlayMessage(db, play.gamePk, play.playIndex, "C1", "play.ts", "header.ts");

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

  test("rescued play row missing in DB skips update entirely", async () => {
    const recorder = mockFetchRecording();
    const logger = makeSilentLogger();
    const notifier = makeBackfillNotifier(
      db,
      { botToken: "xoxb-x", channelId: "C1" },
      logger,
    );

    // Reference exists but no play row was inserted.
    recordGameHeader(db, 745433, "C1", "header.ts");
    recordPlayMessage(db, 745433, 42, "C1", "play.ts", "header.ts");

    await notifier({
      gamePk: 745433,
      playIndex: 42,
      videoUrl: "https://example.com/v.mp4",
      videoTitle: "Watch",
    });

    expect(recorder.calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("concurrent calls for same (gamePk, playIndex) serialize", async () => {
    const order: string[] = [];
    let callIdx = 0;
    let resolveFirst: (v: Response) => void = () => {};
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });

    const calls: FetchCall[] = [];
    globalThis.fetch = Object.assign(
      mock(
        (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          callIdx++;
          calls.push({
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
    recordGameHeader(db, play.gamePk, "C1", "header.ts");
    recordPlayMessage(db, play.gamePk, play.playIndex, "C1", "play.ts", "header.ts");

    const event: BackfillSuccessEvent = {
      gamePk: play.gamePk,
      playIndex: play.playIndex,
      videoUrl: "https://example.com/v.mp4",
      videoTitle: "Watch",
    };

    const p1 = notifier(event);
    const p2 = notifier(event);

    await Bun.sleep(20);
    expect(callIdx).toBe(1);

    resolveFirst(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await Promise.all([p1, p2]);

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

  test("rescues for different plays in same game run independently", async () => {
    // No serialization across plays — both updates should overlap rather
    // than one waiting on the other. We assert that fetch starts for the
    // second play before the first play's pipeline finishes.
    const order: string[] = [];
    let callIdx = 0;
    let resolveFirstPlay: (v: Response) => void = () => {};
    const firstPlayUpdate = new Promise<Response>((resolve) => {
      resolveFirstPlay = resolve;
    });

    globalThis.fetch = Object.assign(
      mock(
        (
          _input: Parameters<typeof fetch>[0],
          _init?: Parameters<typeof fetch>[1],
        ) => {
          callIdx++;
          if (callIdx === 1) {
            order.push("play1-update-start");
            return firstPlayUpdate;
          }
          if (callIdx === 2) {
            order.push("play2-update-start");
            return Promise.resolve(
              new Response(JSON.stringify({ ok: true }), { status: 200 }),
            );
          }
          // any further calls (thread replies) just succeed
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
          );
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

    const play1 = makePlay({ playIndex: 1 });
    const play2 = makePlay({ playIndex: 2 });
    insertPlay(db, play1);
    insertPlay(db, play2);
    recordGameHeader(db, play1.gamePk, "C1", "header.ts");
    recordPlayMessage(db, play1.gamePk, 1, "C1", "play.1.ts", "header.ts");
    recordPlayMessage(db, play2.gamePk, 2, "C1", "play.2.ts", "header.ts");

    const p1 = notifier({
      gamePk: play1.gamePk,
      playIndex: 1,
      videoUrl: "https://example.com/v1.mp4",
      videoTitle: "Watch",
    });
    const p2 = notifier({
      gamePk: play2.gamePk,
      playIndex: 2,
      videoUrl: "https://example.com/v2.mp4",
      videoTitle: "Watch",
    });

    await Bun.sleep(20);
    // Second play's update should have started even though play 1 is blocked.
    expect(order).toEqual(["play1-update-start", "play2-update-start"]);

    resolveFirstPlay(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await Promise.all([p1, p2]);
  });
});
