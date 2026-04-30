/**
 * Tests for the Savant video backfill cycle (runBackfillCycle).
 *
 * Each test seeds an in-memory DB, mocks globalThis.fetch (which Savant's
 * fetchSavantVideo uses under the hood), runs one cycle, and inspects
 * the stats and the resulting DB rows.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createDatabase,
  insertPlay,
  insertPlays,
  queryPlays,
  type DetectedPlay,
} from "../../storage/db";
import { runBackfillCycle, type BackfillSuccessEvent } from "../backfill";
import type { Logger } from "../../logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSilentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

/**
 * Installs a global fetch mock that satisfies the real fetch type
 * (preconnect is required on typeof fetch).
 */
function installFetchMock(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  globalThis.fetch = Object.assign(mock(fn), {
    preconnect: mock((_url: string | URL) => {}),
  });
}

function todayIso(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function makeMockPlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 717401,
    playIndex: 42,
    date: todayIso(),
    fielderId: 641355,
    fielderName: "Cody Bellinger",
    fielderPosition: "CF",
    runnerId: 543807,
    runnerName: "Kyle Schwarber",
    targetBase: "3B",
    batterName: "Trea Turner",
    inning: 5,
    halfInning: "top",
    awayScore: 2,
    homeScore: 3,
    awayTeam: "CHC",
    homeTeam: "PHI",
    description: "Trea Turner flies out to center fielder Cody Bellinger.",
    creditChain: "CF -> 3B",
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

const SUCCESS_HTML = `
  <html><body>
    <video>
      <source src="https://sporty-clips.mlb.com/test.mp4" type="video/mp4">
    </video>
  </body></html>
`;

const NO_VIDEO_HTML = `<html><body>No Video Found</body></html>`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runBackfillCycle", () => {
  let db: Database;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  test("successful Savant fetch updates video_url, video_title, fetch_status='success'", async () => {
    insertPlay(
      db,
      makeMockPlay({
        playId: "abc",
        fetchStatus: "timeout",
        date: todayIso(),
      }),
    );

    installFetchMock(() =>
      Promise.resolve(new Response(SUCCESS_HTML, { status: 200 })),
    );

    const stats = await runBackfillCycle(db, makeSilentLogger());

    expect(stats.attempted).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(stats.stillPending).toBe(0);

    const row = queryPlays(db, { limit: 10 })[0];
    expect(row.videoUrl).toBe("https://sporty-clips.mlb.com/test.mp4");
    expect(row.videoTitle).toBe("Baseball Savant Video");
    expect(row.fetchStatus).toBe("success");
  });

  test("multiple runner rows for same play receive the same video and one Savant call", async () => {
    insertPlays(db, [
      makeMockPlay({
        playId: "abc",
        runnerId: 1001,
        playIndex: 7,
        fetchStatus: null,
      }),
      makeMockPlay({
        playId: "abc",
        runnerId: 1002,
        playIndex: 7,
        fetchStatus: null,
      }),
    ]);

    let calls = 0;
    installFetchMock(() => {
      calls++;
      return Promise.resolve(new Response(SUCCESS_HTML, { status: 200 }));
    });

    const stats = await runBackfillCycle(db, makeSilentLogger());

    expect(calls).toBe(1);
    expect(stats.attempted).toBe(1);
    expect(stats.succeeded).toBe(1);

    const rows = queryPlays(db, { limit: 10 });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.videoUrl).toBe("https://sporty-clips.mlb.com/test.mp4");
      expect(r.fetchStatus).toBe("success");
    }
  });

  test("rows with terminal fetch_status='no_video_found' are skipped", async () => {
    insertPlay(
      db,
      makeMockPlay({ playId: "abc", fetchStatus: "no_video_found" }),
    );

    let calls = 0;
    installFetchMock(() => {
      calls++;
      return Promise.resolve(new Response(SUCCESS_HTML, { status: 200 }));
    });

    const stats = await runBackfillCycle(db, makeSilentLogger());

    expect(calls).toBe(0);
    expect(stats.attempted).toBe(0);
  });

  test("rows older than the window are excluded", async () => {
    insertPlay(
      db,
      makeMockPlay({ playId: "abc", date: daysAgo(3), fetchStatus: null }),
    );

    let calls = 0;
    installFetchMock(() => {
      calls++;
      return Promise.resolve(new Response(SUCCESS_HTML, { status: 200 }));
    });

    const stats = await runBackfillCycle(db, makeSilentLogger(), {
      windowDays: 2,
    });

    expect(calls).toBe(0);
    expect(stats.attempted).toBe(0);
  });

  test("rows with NULL play_id are excluded", async () => {
    insertPlay(db, makeMockPlay({ playId: null, fetchStatus: null }));

    let calls = 0;
    installFetchMock(() => {
      calls++;
      return Promise.resolve(new Response(SUCCESS_HTML, { status: 200 }));
    });

    const stats = await runBackfillCycle(db, makeSilentLogger());

    expect(calls).toBe(0);
    expect(stats.attempted).toBe(0);
  });

  test("non-success result writes fetch_status without touching video_url", async () => {
    insertPlay(
      db,
      makeMockPlay({ playId: "abc", fetchStatus: null, date: todayIso() }),
    );

    installFetchMock(() =>
      Promise.resolve(new Response(NO_VIDEO_HTML, { status: 200 })),
    );

    const stats = await runBackfillCycle(db, makeSilentLogger());

    expect(stats.attempted).toBe(1);
    expect(stats.succeeded).toBe(0);
    expect(stats.stillPending).toBe(1);

    const row = queryPlays(db, { limit: 10 })[0];
    expect(row.videoUrl).toBeNull();
    expect(row.fetchStatus).toBe("no_video_found");
  });

  test("non_200 response writes fetch_status='non_200'", async () => {
    insertPlay(
      db,
      makeMockPlay({ playId: "abc", fetchStatus: null, date: todayIso() }),
    );

    installFetchMock(() =>
      Promise.resolve(new Response("server error", { status: 503 })),
    );

    const stats = await runBackfillCycle(db, makeSilentLogger());

    expect(stats.stillPending).toBe(1);
    const row = queryPlays(db, { limit: 10 })[0];
    expect(row.videoUrl).toBeNull();
    expect(row.fetchStatus).toBe("non_200");
  });

  test("isShuttingDown thunk aborts the loop before subsequent candidates", async () => {
    insertPlays(db, [
      makeMockPlay({
        playId: "abc",
        runnerId: 1,
        playIndex: 1,
        date: todayIso(),
      }),
      makeMockPlay({
        playId: "def",
        runnerId: 2,
        playIndex: 2,
        date: todayIso(),
      }),
      makeMockPlay({
        playId: "ghi",
        runnerId: 3,
        playIndex: 3,
        date: todayIso(),
      }),
    ]);

    let shouldStop = false;
    let calls = 0;

    installFetchMock(() => {
      calls++;
      // Trigger shutdown after the first request lands.
      shouldStop = true;
      return Promise.resolve(new Response(SUCCESS_HTML, { status: 200 }));
    });

    const stats = await runBackfillCycle(db, makeSilentLogger(), {
      isShuttingDown: () => shouldStop,
    });

    expect(calls).toBe(1);
    expect(stats.attempted).toBe(1);
    expect(stats.succeeded).toBe(1);
  });

  test("onSuccess callback fires once per successful row group", async () => {
    insertPlays(db, [
      makeMockPlay({
        playId: "abc",
        runnerId: 1,
        playIndex: 1,
        date: todayIso(),
      }),
      // Same play, second runner — should not produce a second onSuccess.
      makeMockPlay({
        playId: "abc",
        runnerId: 2,
        playIndex: 1,
        date: todayIso(),
      }),
      makeMockPlay({
        playId: "def",
        runnerId: 3,
        playIndex: 2,
        date: todayIso(),
      }),
    ]);

    installFetchMock(() =>
      Promise.resolve(new Response(SUCCESS_HTML, { status: 200 })),
    );

    const events: BackfillSuccessEvent[] = [];
    const stats = await runBackfillCycle(db, makeSilentLogger(), {
      onSuccess: (event) => {
        events.push(event);
      },
    });

    expect(stats.attempted).toBe(2);
    expect(stats.succeeded).toBe(2);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.playIndex).sort()).toEqual([1, 2]);
  });

  test("rows with fetch_status='success' are skipped even if video_url is NULL", async () => {
    // Rows reach this state only if data is inconsistent, but the query's
    // explicit exclusion on fetch_status='success' should still hold.
    insertPlay(
      db,
      makeMockPlay({ playId: "abc", fetchStatus: "success", videoUrl: null }),
    );

    let calls = 0;
    installFetchMock(() => {
      calls++;
      return Promise.resolve(new Response(SUCCESS_HTML, { status: 200 }));
    });

    const stats = await runBackfillCycle(db, makeSilentLogger());

    expect(calls).toBe(0);
    expect(stats.attempted).toBe(0);
  });
});
