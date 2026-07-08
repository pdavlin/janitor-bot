/**
 * Integration tests for the server-rendered website pages (batch 1).
 *
 * Starts a real Bun server against an in-memory SQLite database and
 * asserts each page renders with the expected content type and marker
 * content, that the highlights filters and paging work end to end, that
 * DB-sourced strings are HTML-escaped, that the team asset route serves
 * PNGs, and that every page survives an empty database.
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
    date: "2026-06-23",
    fielderId: 641355,
    fielderName: "Andy Pages",
    fielderPosition: "CF",
    runnerId: 543807,
    runnerName: "Austin Martin",
    targetBase: "Home",
    batterName: "Trea Turner",
    inning: 3,
    halfInning: "bottom",
    awayScore: 2,
    homeScore: 1,
    awayTeam: "LAD",
    homeTeam: "MIN",
    description: "Andy Pages throws out Austin Martin at home.",
    creditChain: "CF -> SS -> C",
    tier: "high",
    outs: 2,
    runnersOn: "1st",
    isOverturned: false,
    playId: null,
    fetchStatus: null,
    videoUrl: "https://example.com/clip.mp4",
    videoTitle: "Pages cuts down Martin",
    throwVelocity: null,
    throwVelocityStatus: null,
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
    gamesTracked: 0,
    gamesLive: 0,
    gamesFinal: 0,
    gamesAbandoned: 0,
    currentDate: "2026-06-23",
    lastPollTime: null,
  };
}

/** Counts non-overlapping occurrences of needle in haystack. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const PLAY_HIGH_VIDEO = makeMockPlay();
const PLAY_MEDIUM_NO_VIDEO = makeMockPlay({
  gamePk: 717402,
  playIndex: 10,
  date: "2026-06-22",
  fielderName: "Wilyer Abreu",
  fielderPosition: "RF",
  runnerName: "Willi Castro",
  targetBase: "3B",
  halfInning: "top",
  awayTeam: "BOS",
  homeTeam: "COL",
  creditChain: "RF -> 3B",
  tier: "medium",
  videoUrl: null,
  videoTitle: null,
  runnersOn: "",
});
const PLAY_LOW_OVERTURNED = makeMockPlay({
  gamePk: 717403,
  playIndex: 5,
  date: "2026-06-21",
  fielderName: "Chandler Simpson",
  fielderPosition: "LF",
  runnerName: "Tyler Tolbert",
  targetBase: "2B",
  halfInning: "top",
  awayTeam: "KC",
  homeTeam: "TB",
  creditChain: "LF -> SS -> 2B",
  tier: "low",
  isOverturned: true,
});
const PLAY_UNSAFE_NAME = makeMockPlay({
  gamePk: 717404,
  playIndex: 7,
  date: "2026-06-20",
  fielderName: '<script>alert("x")</script> Jones',
  runnerName: 'O"Neill & <b>Sons</b>',
  awayTeam: "SEA",
  homeTeam: "DET",
  creditChain: "CF -> C",
  tier: "high",
});

const ALL_PLAYS = [
  PLAY_HIGH_VIDEO,
  PLAY_MEDIUM_NO_VIDEO,
  PLAY_LOW_OVERTURNED,
  PLAY_UNSAFE_NAME,
];

// ---------------------------------------------------------------------------
// Seeded server
// ---------------------------------------------------------------------------

describe("website pages (seeded DB)", () => {
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

  async function getPage(path: string): Promise<{ res: Response; body: string }> {
    const res = await fetch(`${baseUrl}${path}`);
    const body = await res.text();
    return { res, body };
  }

  // -------------------------------------------------------------------------
  // GET /
  // -------------------------------------------------------------------------

  describe("GET /", () => {
    test("renders stat tiles and recent high-tier plays with video", async () => {
      const { res, body } = await getPage("/");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");

      expect(body).toContain("plays tracked");
      expect(body).toContain("high tier");
      expect(body).toContain("season span");
      // 4 seeded plays, 2 high tier
      expect(body).toContain(">4</span>");
      expect(body).toContain(">2</span>");
      // season range Jun 20 - Jun 23
      expect(body).toContain("Jun 20");
      expect(body).toContain("Jun 23");
      // recent highlights: high-tier plays with video only
      expect(body).toContain("Andy Pages");
      expect(body).not.toContain("Wilyer Abreu");
      expect(body).toContain("&#9654; watch");
      expect(body).toContain('href="/highlights"');
    });

    test("marks home as the current nav page", async () => {
      const { body } = await getPage("/");
      expect(body).toContain('href="/" aria-current="page"');
    });

    test("escapes DB-sourced names", async () => {
      const { body } = await getPage("/");
      expect(body).not.toContain('<script>alert("x")</script>');
      expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Jones");
    });
  });

  // -------------------------------------------------------------------------
  // GET /highlights
  // -------------------------------------------------------------------------

  describe("GET /highlights", () => {
    test("renders every seeded play as a card", async () => {
      const { res, body } = await getPage("/highlights");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(countOf(body, '<fieldset class="card">')).toBe(4);
      expect(body).toContain("Andy Pages");
      expect(body).toContain("Wilyer Abreu");
      expect(body).toContain("Chandler Simpson");
    });

    test("shows relay/direct kind, overturned tag, and no-video state", async () => {
      const { body } = await getPage("/highlights");
      expect(body).toContain('<span class="kind relay">relay</span>');
      expect(body).toContain('<span class="kind">direct</span>');
      expect(body).toContain(">overturned</span>");
      expect(body).toContain('<span class="no-video">no video</span>');
    });

    test("filters by tier and persists the selection in the form", async () => {
      const { body } = await getPage("/highlights?tier=medium");
      expect(countOf(body, '<fieldset class="card">')).toBe(1);
      expect(body).toContain("Wilyer Abreu");
      expect(body).not.toContain("Andy Pages");
      expect(body).toContain('<option value="medium" selected>');
    });

    test("filters by team, position, and base", async () => {
      const byTeam = await getPage("/highlights?team=KC");
      expect(countOf(byTeam.body, '<fieldset class="card">')).toBe(1);
      expect(byTeam.body).toContain("Chandler Simpson");
      expect(byTeam.body).toContain('<option value="KC" selected>');

      const byPosition = await getPage("/highlights?position=RF");
      expect(countOf(byPosition.body, '<fieldset class="card">')).toBe(1);
      expect(byPosition.body).toContain("Wilyer Abreu");

      const byBase = await getPage("/highlights?base=Home");
      expect(countOf(byBase.body, '<fieldset class="card">')).toBe(2);
    });

    test("ignores invalid filter values instead of failing", async () => {
      const { res, body } = await getPage("/highlights?tier=ultra&position=SS&base=1B");
      expect(res.status).toBe(200);
      expect(countOf(body, '<fieldset class="card">')).toBe(4);
    });

    test("shows a filtered empty state", async () => {
      const { res, body } = await getPage("/highlights?tier=low&team=LAD");
      expect(res.status).toBe(200);
      expect(body).toContain("no plays match these filters.");
    });

    test("pages at 14 with filter-preserving older/newer links", async () => {
      const extras: DetectedPlay[] = [];
      for (let i = 0; i < 16; i++) {
        extras.push(
          makeMockPlay({
            gamePk: 800000 + i,
            playIndex: i,
            runnerId: 600000 + i,
            date: "2026-06-19",
            tier: "high",
          }),
        );
      }
      db.run("DELETE FROM plays");
      insertPlays(db, extras);

      const first = await getPage("/highlights?tier=high");
      expect(countOf(first.body, '<fieldset class="card">')).toBe(14);
      expect(first.body).toContain('href="/highlights?tier=high&amp;offset=14"');
      expect(first.body).toContain("older");
      expect(first.body).not.toContain("newer");

      const second = await getPage("/highlights?tier=high&offset=14");
      expect(countOf(second.body, '<fieldset class="card">')).toBe(2);
      expect(second.body).toContain('href="/highlights?tier=high"');
      expect(second.body).toContain("newer");
      expect(second.body).not.toContain("older &rarr;");
    });

    test("renders team logo badges for mapped teams", async () => {
      const { body } = await getPage("/highlights");
      expect(body).toContain('src="/assets/teams/LAD.png" alt="LAD" width="20" height="20"');
    });
  });

  // -------------------------------------------------------------------------
  // GET /season
  // -------------------------------------------------------------------------

  describe("GET /season", () => {
    test("renders all four charts, leaderboard, and burned teams", async () => {
      const { res, body } = await getPage("/season");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");

      expect(body).toContain("plays per week");
      expect(body).toContain("tier distribution");
      expect(body).toContain("target base breakdown");
      expect(body).toContain("direct vs relay");
      expect(body).toContain("arm leaderboard");
      expect(body).toContain("teams most burned");
      expect(countOf(body, '<svg class="chart"')).toBe(4);
      expect(countOf(body, "data table")).toBe(4);
      // subhead with total and range
      expect(body).toContain("4 outfield assists tracked");
      // leaderboard includes the top fielder (Andy Pages has 1 assist)
      expect(body).toContain("Andy Pages");
      // burned teams counted by batting side: LAD bottom half -> home team MIN
      expect(body).toContain('<span class="abbr">MIN</span>');
      // tooltip enhancement present
      expect(body).toContain('id="tt"');
      expect(body).toContain('querySelectorAll(".mark")');
    });

    test("escapes DB-sourced strings in the leaderboard", async () => {
      const { body } = await getPage("/season");
      expect(body).not.toContain('<script>alert("x")</script>');
    });
  });

  // -------------------------------------------------------------------------
  // GET /about
  // -------------------------------------------------------------------------

  describe("GET /about", () => {
    test("renders the five pipeline stages with tier copy matching ranking.ts", async () => {
      const { res, body } = await getPage("/about");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");

      for (const stage of ["detect", "tier", "post", "vote", "review"]) {
        expect(body).toContain(`<legend>${stage}</legend>`);
      }
      // Scoring contract with src/detection/ranking.ts
      expect(body).toContain("Home 4, 3B 3, 2B 1");
      expect(body).toContain("A direct throw adds 2");
      expect(body).toContain("3+ fielders subtracts 2");
      expect(body).toContain("Available video adds 1");
      expect(body).toContain("replay overturn subtracts 2");
      expect(body).toContain("95+ mph adds 1");
      expect(body).toContain("(5+)");
      expect(body).toContain("(3&ndash;4)");
      expect(body).toContain("(0&ndash;2)");
    });
  });

  // -------------------------------------------------------------------------
  // GET /assets/teams/:abbr.png
  // -------------------------------------------------------------------------

  describe("GET /assets/teams/:abbr.png", () => {
    test("serves a mapped team logo with long cache headers", async () => {
      const res = await fetch(`${baseUrl}/assets/teams/LAD.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Cache-Control")).toContain("max-age=604800");
      const bytes = await res.arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(0);
    });

    test("is case-insensitive on the abbreviation", async () => {
      const res = await fetch(`${baseUrl}/assets/teams/lad.png`);
      expect(res.status).toBe(200);
    });

    test("returns 404 for unknown teams", async () => {
      const res = await fetch(`${baseUrl}/assets/teams/ZZZ.png`);
      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// Empty database
// ---------------------------------------------------------------------------

describe("website pages (empty DB)", () => {
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

  test("home renders zeros and an empty highlights state", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(">0</span>");
    expect(body).toContain("no high-tier plays with video yet.");
  });

  test("highlights renders an empty state", async () => {
    const res = await fetch(`${baseUrl}/highlights`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("no plays tracked yet.");
    expect(body).not.toContain('<fieldset class="card">');
  });

  test("season renders no-data notes instead of charts", async () => {
    const res = await fetch(`${baseUrl}/season`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("0 outfield assists tracked");
    expect(body.split("no data yet.").length - 1).toBe(6);
    expect(body).not.toContain('<svg class="chart"');
  });

  test("about renders (static page)", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<legend>detect</legend>");
  });
});
