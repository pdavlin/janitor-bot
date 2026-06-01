/**
 * Tests for the throw-velocity backfill.
 *
 * Covers: matched -> velocity + status 'matched'; no_match -> NULL velocity
 * + status 'no_match' (no magic sentinel); idempotent re-run skips
 * already-attempted rows; the tier column is never mutated.
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createLogger } from "../../logger";
import { createDatabase, insertPlay } from "../../storage/db";
import { clearThrowCache } from "../../detection/arm-velocity";
import { runBackfill } from "../backfill-throw-velocity";
import type { DetectedPlay } from "../../types/play";

const silentLogger = createLogger("error");

function makeMockPlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 717401,
    playIndex: 1,
    date: "2026-05-24",
    fielderId: 660271,
    fielderName: "Test Fielder",
    fielderPosition: "RF",
    runnerId: 100,
    runnerName: "Test Runner",
    targetBase: "3B",
    batterName: "Test Batter",
    inning: 5,
    halfInning: "top",
    awayScore: 2,
    homeScore: 3,
    awayTeam: "CHC",
    homeTeam: "PHI",
    description: "flies out to right fielder.",
    creditChain: "RF -> 3B",
    tier: "high",
    outs: 1,
    runnersOn: "1st",
    isOverturned: false,
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    throwVelocity: null,
    throwVelocityStatus: null,
    ...overrides,
  };
}

const THROWS = [
  { year: 2026, fielder_id: 660271, pos: 9, pos_role: 9, metric: 95.5, play_id: "match-1" },
];

function seededDb(): Database {
  const db = createDatabase(":memory:");
  // play A is tracked (play_id present in THROWS); play B is untracked
  insertPlay(db, makeMockPlay({ playIndex: 1, runnerId: 100, playId: "match-1", tier: "high" }));
  insertPlay(db, makeMockPlay({ playIndex: 2, runnerId: 200, playId: "no-match-x", tier: "low" }));
  return db;
}

function readPlay(db: Database, playIndex: number) {
  return db
    .prepare("SELECT tier, throw_velocity, throw_velocity_status FROM plays WHERE play_index = $i;")
    .get({ $i: playIndex }) as {
    tier: string;
    throw_velocity: number | null;
    throw_velocity_status: string | null;
  };
}

describe("runBackfill", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(THROWS), { status: 200 })),
    ) as unknown as typeof fetch;
    clearThrowCache();
  });

  test("matched play gets velocity + status; untracked gets status only, NULL velocity", async () => {
    const db = seededDb();
    const summary = await runBackfill(db, silentLogger);

    expect(summary).toEqual({ matched: 1, noMatch: 1, errors: 0, tierInvariantHeld: true });

    const a = readPlay(db, 1);
    expect(a.throw_velocity).toBe(95.5);
    expect(a.throw_velocity_status).toBe("matched");

    const b = readPlay(db, 2);
    expect(b.throw_velocity).toBeNull(); // no -1 sentinel
    expect(b.throw_velocity_status).toBe("no_match");

    db.close();
  });

  test("never mutates the tier column", async () => {
    const db = seededDb();
    await runBackfill(db, silentLogger);
    expect(readPlay(db, 1).tier).toBe("high");
    expect(readPlay(db, 2).tier).toBe("low");
    db.close();
  });

  test("idempotent: re-run skips already-attempted rows", async () => {
    const db = seededDb();
    await runBackfill(db, silentLogger);
    const second = await runBackfill(db, silentLogger);
    expect(second).toEqual({ matched: 0, noMatch: 0, errors: 0, tierInvariantHeld: true });
    db.close();
  });
});
