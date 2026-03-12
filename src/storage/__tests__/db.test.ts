/**
 * Tests for the storage layer (db.ts).
 *
 * Covers Phase 3 additions: extended PlayFilters (from/to, position, base,
 * limit, offset), queryPlayCount, queryPlayById, queryPlayStats, getDbStats.
 *
 * Every test suite creates a fresh :memory: database to avoid state leakage.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createDatabase,
  insertPlay,
  insertPlays,
  queryPlays,
  queryPlayCount,
  queryPlayById,
  queryPlayStats,
  getDbStats,
} from "../db";
import type { DetectedPlay, StoredPlay, PlayFilters } from "../db";

// ---------------------------------------------------------------------------
// Test data helper
// ---------------------------------------------------------------------------

/**
 * Returns a DetectedPlay with sensible defaults. Any field can be
 * overridden via the partial argument.
 */
function makeMockPlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 717401,
    playIndex: 42,
    date: "2024-04-09",
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
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PlayFilters extensions
// ---------------------------------------------------------------------------

describe("PlayFilters extensions", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");

    // Seed three plays across different dates, positions, bases, and teams.
    insertPlays(db, [
      makeMockPlay({
        date: "2024-04-01",
        fielderPosition: "RF",
        targetBase: "Home",
        awayTeam: "NYY",
        homeTeam: "BOS",
        tier: "high",
        runnerId: 1,
        playIndex: 1,
      }),
      makeMockPlay({
        date: "2024-04-05",
        fielderPosition: "CF",
        targetBase: "3B",
        awayTeam: "CHC",
        homeTeam: "PHI",
        tier: "medium",
        runnerId: 2,
        playIndex: 2,
      }),
      makeMockPlay({
        date: "2024-04-10",
        fielderPosition: "LF",
        targetBase: "2B",
        awayTeam: "LAD",
        homeTeam: "SF",
        tier: "low",
        runnerId: 3,
        playIndex: 3,
      }),
    ]);
  });

  // -- from / to date range filtering --

  test("from filter returns plays on or after the given date", () => {
    const results = queryPlays(db, { from: "2024-04-05" });
    expect(results).toHaveLength(2);
    const dates = results.map((r) => r.date);
    expect(dates).toContain("2024-04-05");
    expect(dates).toContain("2024-04-10");
  });

  test("to filter returns plays on or before the given date", () => {
    const results = queryPlays(db, { to: "2024-04-05" });
    expect(results).toHaveLength(2);
    const dates = results.map((r) => r.date);
    expect(dates).toContain("2024-04-01");
    expect(dates).toContain("2024-04-05");
  });

  test("from and to together form an inclusive date range", () => {
    const results = queryPlays(db, {
      from: "2024-04-01",
      to: "2024-04-05",
    });
    expect(results).toHaveLength(2);
  });

  test("from and to on the same date returns plays for that single day", () => {
    const results = queryPlays(db, {
      from: "2024-04-05",
      to: "2024-04-05",
    });
    expect(results).toHaveLength(1);
    expect(results[0].date).toBe("2024-04-05");
  });

  // -- position filter --

  test("position filter matches exact fielder_position", () => {
    const results = queryPlays(db, { position: "RF" });
    expect(results).toHaveLength(1);
    expect(results[0].fielderPosition).toBe("RF");
  });

  test("position filter returns nothing for unmatched position", () => {
    const results = queryPlays(db, { position: "SS" });
    expect(results).toHaveLength(0);
  });

  // -- base filter --

  test("base filter matches exact target_base", () => {
    const results = queryPlays(db, { base: "Home" });
    expect(results).toHaveLength(1);
    expect(results[0].targetBase).toBe("Home");
  });

  // -- combined filters --

  test("combining team + tier + position narrows results", () => {
    const results = queryPlays(db, {
      team: "CHC",
      tier: "medium",
      position: "CF",
    });
    expect(results).toHaveLength(1);
    expect(results[0].awayTeam).toBe("CHC");
    expect(results[0].tier).toBe("medium");
    expect(results[0].fielderPosition).toBe("CF");
  });

  test("combined filters that match nothing return empty array", () => {
    const results = queryPlays(db, {
      team: "NYY",
      tier: "low",
    });
    expect(results).toHaveLength(0);
  });

  // -- limit --

  test("default limit is 50", () => {
    // Insert 60 plays total (3 already exist; add 57 more).
    const extra: DetectedPlay[] = [];
    for (let i = 0; i < 57; i++) {
      extra.push(
        makeMockPlay({
          playIndex: 100 + i,
          runnerId: 10000 + i,
        }),
      );
    }
    insertPlays(db, extra);

    const results = queryPlays(db);
    expect(results).toHaveLength(50);
  });

  test("custom limit returns requested number of rows", () => {
    const results = queryPlays(db, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  test("limit is clamped to 200", () => {
    // Insert 210 plays total.
    const bulk: DetectedPlay[] = [];
    for (let i = 0; i < 210; i++) {
      bulk.push(
        makeMockPlay({
          playIndex: 200 + i,
          runnerId: 20000 + i,
        }),
      );
    }
    insertPlays(db, bulk);

    const results = queryPlays(db, { limit: 999 });
    expect(results).toHaveLength(200);
  });

  // -- offset --

  test("offset skips the first N rows for pagination", () => {
    // With 3 plays ordered by date DESC, offset 1 should skip the newest.
    const all = queryPlays(db, { limit: 10 });
    const paginated = queryPlays(db, { limit: 10, offset: 1 });

    expect(paginated).toHaveLength(2);
    expect(paginated[0].id).toBe(all[1].id);
  });
});

// ---------------------------------------------------------------------------
// queryPlayCount
// ---------------------------------------------------------------------------

describe("queryPlayCount", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    insertPlays(db, [
      makeMockPlay({ runnerId: 1, playIndex: 1, tier: "high", awayTeam: "NYY", homeTeam: "BOS" }),
      makeMockPlay({ runnerId: 2, playIndex: 2, tier: "high", awayTeam: "NYY", homeTeam: "BOS" }),
      makeMockPlay({ runnerId: 3, playIndex: 3, tier: "low", awayTeam: "CHC", homeTeam: "PHI" }),
    ]);
  });

  test("returns total count with no filters", () => {
    expect(queryPlayCount(db)).toBe(3);
  });

  test("returns filtered count ignoring limit and offset", () => {
    // queryPlayCount should count all matching rows regardless of pagination.
    expect(queryPlayCount(db, { tier: "high" })).toBe(2);
  });

  test("matches the same filters as queryPlays", () => {
    const filters: PlayFilters = { team: "NYY" };
    const plays = queryPlays(db, { ...filters, limit: 200 });
    const count = queryPlayCount(db, filters);
    expect(count).toBe(plays.length);
  });
});

// ---------------------------------------------------------------------------
// queryPlayById
// ---------------------------------------------------------------------------

describe("queryPlayById", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    insertPlay(db, makeMockPlay());
  });

  test("returns StoredPlay for an existing id", () => {
    const play = queryPlayById(db, 1);
    expect(play).not.toBeNull();
    expect(play!.id).toBe(1);
    expect(play!.fielderName).toBe("Cody Bellinger");
    expect(play!.createdAt).toBeDefined();
  });

  test("returns null for a non-existent id", () => {
    const play = queryPlayById(db, 9999);
    expect(play).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// queryPlayStats
// ---------------------------------------------------------------------------

describe("queryPlayStats", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    insertPlays(db, [
      makeMockPlay({
        date: "2024-04-01",
        tier: "high",
        fielderName: "Juan Soto",
        runnerId: 1,
        playIndex: 1,
        awayTeam: "NYY",
        homeTeam: "BOS",
      }),
      makeMockPlay({
        date: "2024-04-01",
        tier: "high",
        fielderName: "Juan Soto",
        runnerId: 2,
        playIndex: 2,
        awayTeam: "NYY",
        homeTeam: "BOS",
      }),
      makeMockPlay({
        date: "2024-04-05",
        tier: "medium",
        fielderName: "Mookie Betts",
        runnerId: 3,
        playIndex: 3,
        awayTeam: "LAD",
        homeTeam: "SF",
      }),
      makeMockPlay({
        date: "2024-04-10",
        tier: "low",
        fielderName: "Mookie Betts",
        runnerId: 4,
        playIndex: 4,
        awayTeam: "LAD",
        homeTeam: "CHC",
      }),
    ]);
  });

  test("totalByTier returns counts grouped by tier", () => {
    const stats = queryPlayStats(db);
    const tierMap = new Map(stats.totalByTier.map((t) => [t.tier, t.count]));
    expect(tierMap.get("high")).toBe(2);
    expect(tierMap.get("medium")).toBe(1);
    expect(tierMap.get("low")).toBe(1);
  });

  test("topFielders returns fielders ordered by count descending", () => {
    const stats = queryPlayStats(db);
    expect(stats.topFielders[0].fielderName).toBe("Juan Soto");
    expect(stats.topFielders[0].count).toBe(2);
    expect(stats.topFielders[1].fielderName).toBe("Mookie Betts");
    expect(stats.topFielders[1].count).toBe(2);
  });

  test("playsByTeam counts both home and away appearances", () => {
    const stats = queryPlayStats(db);
    const teamMap = new Map(stats.playsByTeam.map((t) => [t.team, t.count]));

    // NYY appears as away in 2 plays, LAD appears as away in 2 plays
    expect(teamMap.get("NYY")).toBe(2);
    expect(teamMap.get("BOS")).toBe(2);
    expect(teamMap.get("LAD")).toBe(2);
    // CHC appears as home in 1 play, SF as home in 1 play
    expect(teamMap.get("CHC")).toBe(1);
    expect(teamMap.get("SF")).toBe(1);
  });

  test("date range filtering works on stats", () => {
    const stats = queryPlayStats(db, "2024-04-01", "2024-04-05");
    const tierMap = new Map(stats.totalByTier.map((t) => [t.tier, t.count]));
    expect(tierMap.get("high")).toBe(2);
    expect(tierMap.get("medium")).toBe(1);
    expect(tierMap.has("low")).toBe(false);
  });

  test("from-only date filter excludes earlier plays", () => {
    const stats = queryPlayStats(db, "2024-04-05");
    const total = stats.totalByTier.reduce((sum, t) => sum + t.count, 0);
    expect(total).toBe(2);
  });

  test("to-only date filter excludes later plays", () => {
    const stats = queryPlayStats(db, undefined, "2024-04-05");
    const total = stats.totalByTier.reduce((sum, t) => sum + t.count, 0);
    expect(total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getDbStats
// ---------------------------------------------------------------------------

describe("getDbStats", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  test("handles empty database with null dates and 0 count", () => {
    const stats = getDbStats(db, ":memory:");
    expect(stats.totalPlays).toBe(0);
    expect(stats.oldestPlay).toBeNull();
    expect(stats.newestPlay).toBeNull();
  });

  test("returns correct totalPlays count", () => {
    insertPlays(db, [
      makeMockPlay({ runnerId: 1, playIndex: 1 }),
      makeMockPlay({ runnerId: 2, playIndex: 2 }),
    ]);
    const stats = getDbStats(db, ":memory:");
    expect(stats.totalPlays).toBe(2);
  });

  test("returns oldest and newest dates", () => {
    insertPlays(db, [
      makeMockPlay({ date: "2024-03-28", runnerId: 1, playIndex: 1 }),
      makeMockPlay({ date: "2024-09-29", runnerId: 2, playIndex: 2 }),
      makeMockPlay({ date: "2024-06-15", runnerId: 3, playIndex: 3 }),
    ]);
    const stats = getDbStats(db, ":memory:");
    expect(stats.oldestPlay).toBe("2024-03-28");
    expect(stats.newestPlay).toBe("2024-09-29");
  });

  test("dbSizeBytes is 0 for :memory: database", () => {
    const stats = getDbStats(db, ":memory:");
    expect(stats.dbSizeBytes).toBe(0);
  });
});
