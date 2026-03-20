/**
 * Integration tests for the HTTP server routes.
 *
 * Starts a real Bun server on a random port with an in-memory SQLite
 * database and issues actual fetch() requests against each endpoint.
 * This exercises the full stack from HTTP through to the storage layer.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
} from "bun:test";
import { startServer } from "../routes";
import { createDatabase, insertPlays } from "../../storage/db";
import type { SchedulerStatus } from "../../daemon/scheduler";
import type { DetectedPlay } from "../../types/play";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { Logger } from "../../logger";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

/** Silent logger that swallows all output. */
function makeSilentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

function makeSchedulerStatus(): SchedulerStatus {
  return {
    gamesTracked: 4,
    gamesLive: 1,
    gamesFinal: 2,
    gamesAbandoned: 0,
    currentDate: "2024-04-10",
    lastPollTime: "2024-04-10T20:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const PLAY_BELLINGER = makeMockPlay();
const PLAY_WADE = makeMockPlay({
  playIndex: 43,
  fielderId: 664774,
  fielderName: "LaMonte Wade Jr.",
  fielderPosition: "RF",
  runnerId: 999,
  runnerName: "Fake Runner",
  targetBase: "Home",
  tier: "medium",
  description: "Wade Jr. throws out runner at home.",
  creditChain: "RF -> C",
});
const PLAY_BETTS = makeMockPlay({
  gamePk: 717402,
  playIndex: 10,
  date: "2024-04-10",
  fielderId: 605141,
  fielderName: "Mookie Betts",
  fielderPosition: "RF",
  runnerId: 543808,
  runnerName: "Brandon Crawford",
  targetBase: "Home",
  batterName: "Wilmer Flores",
  awayTeam: "LAD",
  homeTeam: "SF",
  description: "Betts throws out Crawford at home.",
  creditChain: "RF -> C",
  tier: "high",
});
const PLAY_ACUNA = makeMockPlay({
  gamePk: 717403,
  playIndex: 20,
  date: "2024-04-10",
  fielderId: 660670,
  fielderName: "Ronald Acuna Jr.",
  fielderPosition: "LF",
  runnerId: 543809,
  runnerName: "Pete Alonso",
  targetBase: "2B",
  batterName: "Francisco Lindor",
  awayTeam: "ATL",
  homeTeam: "NYM",
  description: "Acuna throws out Alonso at second.",
  creditChain: "LF -> SS -> 2B",
  tier: "low",
});

const ALL_PLAYS = [PLAY_BELLINGER, PLAY_WADE, PLAY_BETTS, PLAY_ACUNA];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("HTTP server routes", () => {
  let db: Database;
  let server: Server<undefined>;
  let baseUrl: string;

  beforeAll(() => {
    db = createDatabase(":memory:");
    server = startServer({
      db,
      dbPath: ":memory:",
      logger: makeSilentLogger(),
      port: 0,
      getSchedulerStatus: makeSchedulerStatus,
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM plays");
    insertPlays(db, ALL_PLAYS);
  });

  // -------------------------------------------------------------------------
  // Helper
  // -------------------------------------------------------------------------

  async function get(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`);
  }

  // -------------------------------------------------------------------------
  // GET /plays
  // -------------------------------------------------------------------------

  describe("GET /plays", () => {
    test("returns plays with default pagination", async () => {
      const res = await get("/plays");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.plays).toHaveLength(4);
      expect(body.total).toBe(4);
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
    });

    test("filters by date", async () => {
      const res = await get("/plays?date=2024-04-09");
      const body = await res.json();
      expect(body.plays).toHaveLength(2);
      expect(body.total).toBe(2);
      for (const play of body.plays) {
        expect(play.date).toBe("2024-04-09");
      }
    });

    test("filters by tier", async () => {
      const res = await get("/plays?tier=high");
      const body = await res.json();
      expect(body.plays).toHaveLength(2);
      for (const play of body.plays) {
        expect(play.tier).toBe("high");
      }
    });

    test("filters by team matching away", async () => {
      const res = await get("/plays?team=LAD");
      const body = await res.json();
      expect(body.plays).toHaveLength(1);
      expect(body.plays[0].fielderName).toBe("Mookie Betts");
    });

    test("filters by team matching home", async () => {
      const res = await get("/plays?team=PHI");
      const body = await res.json();
      expect(body.plays).toHaveLength(2);
    });

    test("filters by position", async () => {
      const res = await get("/plays?position=LF");
      const body = await res.json();
      expect(body.plays).toHaveLength(1);
      expect(body.plays[0].fielderName).toBe("Ronald Acuna Jr.");
    });

    test("filters by base", async () => {
      const res = await get("/plays?base=Home");
      const body = await res.json();
      expect(body.plays).toHaveLength(2);
      for (const play of body.plays) {
        expect(play.targetBase).toBe("Home");
      }
    });

    test("filters by fielder substring", async () => {
      const res = await get("/plays?fielder=Betts");
      const body = await res.json();
      expect(body.plays).toHaveLength(1);
      expect(body.plays[0].fielderName).toBe("Mookie Betts");
    });

    test("filters by date range from/to", async () => {
      const res = await get("/plays?from=2024-04-10&to=2024-04-10");
      const body = await res.json();
      expect(body.plays).toHaveLength(2);
      for (const play of body.plays) {
        expect(play.date).toBe("2024-04-10");
      }
    });

    test("pagination with limit and offset", async () => {
      const res = await get("/plays?limit=2&offset=0");
      const body = await res.json();
      expect(body.plays).toHaveLength(2);
      expect(body.total).toBe(4);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);

      const res2 = await get("/plays?limit=2&offset=2");
      const body2 = await res2.json();
      expect(body2.plays).toHaveLength(2);
      expect(body2.total).toBe(4);
      expect(body2.offset).toBe(2);
    });

    test("total count is independent of limit", async () => {
      const res = await get("/plays?limit=1");
      const body = await res.json();
      expect(body.plays).toHaveLength(1);
      expect(body.total).toBe(4);
    });

    test("invalid tier returns 400", async () => {
      const res = await get("/plays?tier=ultra");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("tier");
    });

    test("invalid position returns 400", async () => {
      const res = await get("/plays?position=SS");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("position");
    });

    test("invalid base returns 400", async () => {
      const res = await get("/plays?base=1B");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("base");
    });

    test("invalid limit returns 400", async () => {
      const res = await get("/plays?limit=-5");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("limit");
    });
  });

  // -------------------------------------------------------------------------
  // GET /plays/today
  // -------------------------------------------------------------------------

  describe("GET /plays/today", () => {
    test("returns plays for today's date", async () => {
      // Insert a play dated today
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayPlay = makeMockPlay({
        gamePk: 999999,
        playIndex: 1,
        date: todayStr,
        runnerId: 111111,
      });
      insertPlays(db, [todayPlay]);

      const res = await get("/plays/today");
      const body = await res.json();

      // All returned plays should have today's date
      for (const play of body.plays) {
        expect(play.date).toBe(todayStr);
      }
      // Should include the play we just inserted
      expect(body.total).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // GET /plays/:id
  // -------------------------------------------------------------------------

  describe("GET /plays/:id", () => {
    test("returns single play by id", async () => {
      // Get a valid id from the database
      const allRes = await get("/plays?limit=1");
      const allBody = await allRes.json();
      const knownId = allBody.plays[0].id;

      const res = await get(`/plays/${knownId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(knownId);
    });

    test("returns 404 for non-existent id", async () => {
      const res = await get("/plays/99999");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("not found");
    });

    test("returns 400 for non-numeric id", async () => {
      const res = await get("/plays/abc");
      // The route regex only matches digits, so "abc" won't match
      // /plays/:id and will fall through to 404
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /stats
  // -------------------------------------------------------------------------

  describe("GET /stats", () => {
    test("returns aggregate stats", async () => {
      const res = await get("/stats");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.totalByTier).toBeDefined();
      expect(body.topFielders).toBeDefined();
      expect(body.playsByTeam).toBeDefined();

      // Verify tier counts add up
      const tierTotal = body.totalByTier.reduce(
        (sum: number, t: { count: number }) => sum + t.count,
        0,
      );
      expect(tierTotal).toBe(4);
    });

    test("stats respect date range params", async () => {
      const res = await get("/stats?from=2024-04-10&to=2024-04-10");
      expect(res.status).toBe(200);

      const body = await res.json();
      const tierTotal = body.totalByTier.reduce(
        (sum: number, t: { count: number }) => sum + t.count,
        0,
      );
      expect(tierTotal).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  describe("GET /health", () => {
    test("returns 200 with status, database, and scheduler info", async () => {
      const res = await get("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");

      expect(body.database).toBeDefined();
      expect(body.database.totalPlays).toBe(4);

      expect(body.scheduler).toBeDefined();
      expect(body.scheduler.gamesTracked).toBe(4);
      expect(body.scheduler.gamesLive).toBe(1);
      expect(body.scheduler.gamesFinal).toBe(2);
      expect(body.scheduler.currentDate).toBe("2024-04-10");
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting concerns
  // -------------------------------------------------------------------------

  describe("cross-cutting", () => {
    test("CORS headers present on GET responses", async () => {
      const res = await get("/plays");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    });

    test("OPTIONS returns 204 with CORS headers", async () => {
      const res = await fetch(`${baseUrl}/plays`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
        "Content-Type",
      );
    });

    test("unknown path returns 404", async () => {
      const res = await get("/nonexistent");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    test("POST to known path returns 405 with Allow header", async () => {
      const res = await fetch(`${baseUrl}/plays`, { method: "POST" });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, OPTIONS");
      const body = await res.json();
      expect(body.error).toContain("Method not allowed");
    });

    test("POST to unknown path returns 404", async () => {
      const res = await fetch(`${baseUrl}/nonexistent`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    test("CORS headers present on 404 responses", async () => {
      const res = await get("/nonexistent");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    test("CORS headers present on 400 responses", async () => {
      const res = await get("/plays?tier=invalid");
      expect(res.status).toBe(400);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
