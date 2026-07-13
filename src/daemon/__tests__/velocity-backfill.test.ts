/**
 * Tests for the throw-velocity backfill cycle (runVelocityBackfillCycle).
 *
 * Each test seeds an in-memory DB, mocks globalThis.fetch (which
 * arm-velocity's resolveThrowVelocity uses under the hood), runs one or
 * more cycles, and inspects the stats and resulting DB rows.
 *
 * The fixture below is real JSON captured on 2026-07-12 from
 * GET https://baseballsavant.mlb.com/leaderboard/arm-strength/691016/2026
 * (Tyler Soderstrom). The play_id bce66390-... is prod play
 * gamePk=823210 playIndex=13 (2026-06-23), which sat at
 * throw_velocity_status='no_match' in prod because the pipeline looked it
 * up at game-Final time, before Savant's overnight batch published it.
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
import { runVelocityBackfillCycle } from "../backfill";
import { clearThrowCache } from "../../detection/arm-velocity";
import type { Logger } from "../../logger";

// ---------------------------------------------------------------------------
// Real captured fixture (see file header)
// ---------------------------------------------------------------------------

const SODERSTROM_PLAY_ID = "bce66390-ec50-3f2c-b4ad-13a51ef77d1d";
const SODERSTROM_VELOCITY = 86.89907;

const ARM_STRENGTH_FIXTURE = [
  {
    year: 2026,
    fielder_id: 691016,
    pos: 7,
    pos_role: 7,
    metric: 89.95408,
    play_id: "068b5651-de77-3525-84b8-edef1a3bc6aa",
  },
  {
    year: 2026,
    fielder_id: 691016,
    pos: 7,
    pos_role: 7,
    metric: 77.55807,
    play_id: "d41643a3-07a8-33e1-8b1b-03bddc6f1dc7",
  },
  {
    year: 2026,
    fielder_id: 691016,
    pos: 7,
    pos_role: 7,
    metric: SODERSTROM_VELOCITY,
    play_id: SODERSTROM_PLAY_ID,
  },
  {
    year: 2026,
    fielder_id: 691016,
    pos: 7,
    pos_role: 7,
    metric: 83.27926,
    play_id: "19e52384-d73b-3563-ab37-0ad4e188e593",
  },
  {
    year: 2026,
    fielder_id: 691016,
    pos: 7,
    pos_role: 7,
    metric: 87.05449,
    play_id: "8132fc6b-bc30-336c-8188-ce003cede423",
  },
];

/** The same leaderboard as it looked on game night: play not yet published. */
const ARM_STRENGTH_FIXTURE_GAME_NIGHT = ARM_STRENGTH_FIXTURE.filter(
  (r) => r.play_id !== SODERSTROM_PLAY_ID,
);

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

function installFetchMock(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  globalThis.fetch = Object.assign(mock(fn), {
    preconnect: mock((_url: string | URL) => {}),
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function makeMockPlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 823210,
    playIndex: 13,
    date: todayIso(),
    fielderId: 691016,
    fielderName: "Tyler Soderstrom",
    fielderPosition: "LF",
    runnerId: 543807,
    runnerName: "Kyle Schwarber",
    targetBase: "2B",
    batterName: "Trea Turner",
    inning: 5,
    halfInning: "top",
    awayScore: 2,
    homeScore: 3,
    awayTeam: "ATH",
    homeTeam: "PHI",
    description: "Runner thrown out at second by left fielder Tyler Soderstrom.",
    creditChain: "LF -> 2B",
    tier: "high",
    outs: 1,
    runnersOn: "1st",
    isOverturned: false,
    playId: SODERSTROM_PLAY_ID,
    fetchStatus: "success",
    videoUrl: "https://sporty-clips.mlb.com/x.mp4",
    videoTitle: "clip",
    throwVelocity: null,
    throwVelocityStatus: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runVelocityBackfillCycle", () => {
  let db: Database;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = createDatabase(":memory:");
    clearThrowCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  test("retries a prior 'no_match' row and writes velocity once Savant publishes it", async () => {
    insertPlay(db, makeMockPlay({ throwVelocityStatus: "no_match" }));

    installFetchMock(() =>
      Promise.resolve(
        new Response(JSON.stringify(ARM_STRENGTH_FIXTURE), { status: 200 }),
      ),
    );

    const stats = await runVelocityBackfillCycle(db, makeSilentLogger());

    expect(stats.attempted).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.stillUnmatched).toBe(0);

    const row = queryPlays(db, { limit: 10 })[0];
    expect(row.throwVelocity).toBe(SODERSTROM_VELOCITY);
    expect(row.throwVelocityStatus).toBe("matched");
  });

  test("play still absent from the leaderboard stays 'no_match' with NULL velocity", async () => {
    insertPlay(db, makeMockPlay({ throwVelocityStatus: null }));

    installFetchMock(() =>
      Promise.resolve(
        new Response(JSON.stringify(ARM_STRENGTH_FIXTURE_GAME_NIGHT), {
          status: 200,
        }),
      ),
    );

    const stats = await runVelocityBackfillCycle(db, makeSilentLogger());

    expect(stats.attempted).toBe(1);
    expect(stats.matched).toBe(0);
    expect(stats.stillUnmatched).toBe(1);

    const row = queryPlays(db, { limit: 10 })[0];
    expect(row.throwVelocity).toBeNull();
    expect(row.throwVelocityStatus).toBe("no_match");
  });

  test("clears the arm-velocity cache between cycles so fresh data is seen", async () => {
    // Regression for the stale-cache trap: cycle 1 sees the game-night
    // leaderboard (play absent). Cycle 2 must re-fetch — not reuse the
    // cached snapshot — and find the play.
    insertPlay(db, makeMockPlay());

    let call = 0;
    installFetchMock(() => {
      call++;
      const body =
        call === 1 ? ARM_STRENGTH_FIXTURE_GAME_NIGHT : ARM_STRENGTH_FIXTURE;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    });

    const first = await runVelocityBackfillCycle(db, makeSilentLogger());
    expect(first.stillUnmatched).toBe(1);

    const second = await runVelocityBackfillCycle(db, makeSilentLogger());
    expect(call).toBe(2);
    expect(second.matched).toBe(1);

    const row = queryPlays(db, { limit: 10 })[0];
    expect(row.throwVelocity).toBe(SODERSTROM_VELOCITY);
    expect(row.throwVelocityStatus).toBe("matched");
  });

  test("multiple runner rows for the same play are updated by one attempt", async () => {
    insertPlays(db, [
      makeMockPlay({ runnerId: 1001, throwVelocityStatus: "no_match" }),
      makeMockPlay({ runnerId: 1002, throwVelocityStatus: "no_match" }),
    ]);

    let calls = 0;
    installFetchMock(() => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify(ARM_STRENGTH_FIXTURE), { status: 200 }),
      );
    });

    const stats = await runVelocityBackfillCycle(db, makeSilentLogger());

    expect(calls).toBe(1);
    expect(stats.attempted).toBe(1);
    expect(stats.matched).toBe(1);

    const rows = queryPlays(db, { limit: 10 });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.throwVelocity).toBe(SODERSTROM_VELOCITY);
      expect(r.throwVelocityStatus).toBe("matched");
    }
  });

  test("rows older than the window are excluded", async () => {
    insertPlay(
      db,
      makeMockPlay({ date: daysAgo(3), throwVelocityStatus: "no_match" }),
    );

    let calls = 0;
    installFetchMock(() => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify(ARM_STRENGTH_FIXTURE), { status: 200 }),
      );
    });

    const stats = await runVelocityBackfillCycle(db, makeSilentLogger(), {
      windowDays: 2,
    });

    expect(calls).toBe(0);
    expect(stats.attempted).toBe(0);
  });

  test("rows already 'matched' and rows without play_id are excluded", async () => {
    insertPlays(db, [
      makeMockPlay({
        runnerId: 1,
        playIndex: 1,
        throwVelocity: 91.2,
        throwVelocityStatus: "matched",
      }),
      makeMockPlay({ runnerId: 2, playIndex: 2, playId: null }),
    ]);

    let calls = 0;
    installFetchMock(() => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify(ARM_STRENGTH_FIXTURE), { status: 200 }),
      );
    });

    const stats = await runVelocityBackfillCycle(db, makeSilentLogger());

    expect(calls).toBe(0);
    expect(stats.attempted).toBe(0);
  });

  test("fetch error records the status and the row stays retryable", async () => {
    insertPlay(db, makeMockPlay());

    installFetchMock(() =>
      Promise.resolve(new Response("server error", { status: 503 })),
    );

    const stats = await runVelocityBackfillCycle(db, makeSilentLogger());

    expect(stats.attempted).toBe(1);
    expect(stats.errors).toBe(1);

    let row = queryPlays(db, { limit: 10 })[0];
    expect(row.throwVelocity).toBeNull();
    expect(row.throwVelocityStatus).toBe("non_200");

    // Next cycle with a healthy response resolves it.
    installFetchMock(() =>
      Promise.resolve(
        new Response(JSON.stringify(ARM_STRENGTH_FIXTURE), { status: 200 }),
      ),
    );

    const retry = await runVelocityBackfillCycle(db, makeSilentLogger());
    expect(retry.matched).toBe(1);

    row = queryPlays(db, { limit: 10 })[0];
    expect(row.throwVelocity).toBe(SODERSTROM_VELOCITY);
    expect(row.throwVelocityStatus).toBe("matched");
  });

  test("isShuttingDown thunk aborts the loop before subsequent candidates", async () => {
    insertPlays(db, [
      makeMockPlay({ runnerId: 1, playIndex: 1, fielderId: 100001, playId: "p1" }),
      makeMockPlay({ runnerId: 2, playIndex: 2, fielderId: 100002, playId: "p2" }),
      makeMockPlay({ runnerId: 3, playIndex: 3, fielderId: 100003, playId: "p3" }),
    ]);

    let shouldStop = false;
    let calls = 0;

    installFetchMock(() => {
      calls++;
      shouldStop = true;
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });

    const stats = await runVelocityBackfillCycle(db, makeSilentLogger(), {
      isShuttingDown: () => shouldStop,
    });

    expect(calls).toBe(1);
    expect(stats.attempted).toBe(1);
  });
});
