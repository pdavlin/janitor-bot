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
  queryBackfillCandidates,
  updatePlayVideoByPlayKey,
  updatePlayFetchStatus,
  updatePlayId,
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
    outs: 1,
    runnersOn: "1st",
    playId: null,
    fetchStatus: null,
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

// ---------------------------------------------------------------------------
// play_id and fetch_status columns
// ---------------------------------------------------------------------------

describe("play_id and fetch_status persistence", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  test("inserts and reads back play_id and fetch_status", () => {
    insertPlay(
      db,
      makeMockPlay({
        playId: "6571e75b-002e-3a60-bf42-82ef0a45ffd1",
        fetchStatus: "success",
      }),
    );

    const stored = queryPlayById(db, 1);
    expect(stored).not.toBeNull();
    expect(stored!.playId).toBe("6571e75b-002e-3a60-bf42-82ef0a45ffd1");
    expect(stored!.fetchStatus).toBe("success");
  });

  test("null play_id and fetch_status round-trip as null", () => {
    insertPlay(db, makeMockPlay({ playId: null, fetchStatus: null }));
    const stored = queryPlayById(db, 1);
    expect(stored!.playId).toBeNull();
    expect(stored!.fetchStatus).toBeNull();
  });

  test("ON CONFLICT updates fetch_status to the latest probe outcome", () => {
    insertPlay(
      db,
      makeMockPlay({ playId: "abc", fetchStatus: "timeout" }),
    );
    expect(queryPlayById(db, 1)!.fetchStatus).toBe("timeout");

    insertPlay(
      db,
      makeMockPlay({ playId: "abc", fetchStatus: "success" }),
    );
    const after = queryPlayById(db, 1);
    expect(after!.fetchStatus).toBe("success");
    expect(after!.playId).toBe("abc");
  });

  test("ON CONFLICT preserves existing play_id when re-insert has null", () => {
    insertPlay(
      db,
      makeMockPlay({ playId: "original", fetchStatus: "success" }),
    );
    insertPlay(
      db,
      makeMockPlay({ playId: null, fetchStatus: "no_play_id" }),
    );
    const stored = queryPlayById(db, 1);
    expect(stored!.playId).toBe("original");
    expect(stored!.fetchStatus).toBe("no_play_id");
  });

  test("queryBackfillCandidates returns eligible rows and collapses runner duplicates", () => {
    const today = new Date().toISOString().slice(0, 10);
    insertPlays(db, [
      // Eligible: NULL video, has play_id, NULL status
      makeMockPlay({
        playId: "play-a",
        fetchStatus: null,
        date: today,
        playIndex: 1,
        runnerId: 1,
      }),
      // Same play, different runner — should collapse to one candidate
      makeMockPlay({
        playId: "play-a",
        fetchStatus: null,
        date: today,
        playIndex: 1,
        runnerId: 2,
      }),
      // Eligible: retryable transient status
      makeMockPlay({
        playId: "play-b",
        fetchStatus: "timeout",
        date: today,
        playIndex: 2,
        runnerId: 3,
      }),
      // Excluded: success is terminal
      makeMockPlay({
        playId: "play-c",
        fetchStatus: "success",
        date: today,
        playIndex: 3,
        runnerId: 4,
      }),
      // Excluded: no_video_found is terminal
      makeMockPlay({
        playId: "play-d",
        fetchStatus: "no_video_found",
        date: today,
        playIndex: 4,
        runnerId: 5,
      }),
      // Excluded: NULL play_id
      makeMockPlay({
        playId: null,
        fetchStatus: null,
        date: today,
        playIndex: 5,
        runnerId: 6,
      }),
    ]);

    const candidates = queryBackfillCandidates(db, 2);
    const playIds = candidates.map((c) => c.playId).sort();
    expect(playIds).toEqual(["play-a", "play-b"]);
  });

  test("queryBackfillCandidates respects the windowDays cutoff", () => {
    const old = new Date();
    old.setUTCDate(old.getUTCDate() - 5);
    const oldDate = old.toISOString().slice(0, 10);

    insertPlay(
      db,
      makeMockPlay({
        playId: "old-play",
        fetchStatus: null,
        date: oldDate,
        playIndex: 99,
        runnerId: 99,
      }),
    );

    expect(queryBackfillCandidates(db, 2)).toHaveLength(0);
    // Wide window picks it back up.
    expect(queryBackfillCandidates(db, 30)).toHaveLength(1);
  });

  test("updatePlayVideoByPlayKey updates all rows sharing (game_pk, play_index)", () => {
    insertPlays(db, [
      makeMockPlay({ playId: "abc", playIndex: 7, runnerId: 1 }),
      makeMockPlay({ playId: "abc", playIndex: 7, runnerId: 2 }),
      // Different play — should not be affected.
      makeMockPlay({ playId: "xyz", playIndex: 8, runnerId: 3 }),
    ]);

    const changes = updatePlayVideoByPlayKey(
      db,
      717401,
      7,
      "https://video.example/x.mp4",
      "Test Video",
    );
    expect(changes).toBe(2);

    const allRows = queryPlays(db, { limit: 100 });
    const targetRows = allRows.filter((r) => r.playIndex === 7);
    const otherRows = allRows.filter((r) => r.playIndex === 8);

    for (const r of targetRows) {
      expect(r.videoUrl).toBe("https://video.example/x.mp4");
      expect(r.videoTitle).toBe("Test Video");
      expect(r.fetchStatus).toBe("success");
    }
    for (const r of otherRows) {
      expect(r.videoUrl).toBeNull();
    }
  });

  test("updatePlayFetchStatus only mutates fetch_status", () => {
    insertPlays(db, [
      makeMockPlay({ playId: "abc", playIndex: 7, runnerId: 1 }),
      makeMockPlay({ playId: "abc", playIndex: 7, runnerId: 2 }),
    ]);

    const changes = updatePlayFetchStatus(db, 717401, 7, "timeout");
    expect(changes).toBe(2);

    const rows = queryPlays(db, { limit: 100 });
    for (const r of rows) {
      expect(r.fetchStatus).toBe("timeout");
      expect(r.videoUrl).toBeNull();
    }
  });

  test("updatePlayId only fills NULL play_id and is idempotent on populated rows", () => {
    insertPlays(db, [
      makeMockPlay({ playId: null, playIndex: 7, runnerId: 1 }),
      makeMockPlay({ playId: null, playIndex: 7, runnerId: 2 }),
    ]);

    const first = updatePlayId(db, 717401, 7, "new-play-id");
    expect(first).toBe(2);

    // Second invocation must not overwrite.
    const second = updatePlayId(db, 717401, 7, "different-play-id");
    expect(second).toBe(0);

    const rows = queryPlays(db, { limit: 100 });
    for (const r of rows) {
      expect(r.playId).toBe("new-play-id");
    }
  });

  test("supports all FetchStatus literal values", () => {
    const statuses = [
      "success",
      "no_video_found",
      "no_source_tag",
      "non_200",
      "timeout",
      "network_error",
      "no_play_id",
      "pending",
    ] as const;

    statuses.forEach((status, i) => {
      insertPlay(
        db,
        makeMockPlay({
          runnerId: 1000 + i,
          playIndex: 1000 + i,
          fetchStatus: status,
        }),
      );
    });

    const stored = queryPlays(db, { limit: 200 });
    const seen = new Set(stored.map((p) => p.fetchStatus));
    statuses.forEach((s) => expect(seen.has(s)).toBe(true));
  });
});
