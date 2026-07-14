/**
 * Integration tests for the batch-3 "Cannon Update" surfaces: the /season
 * velocity sections, the /fielders/:id profile page, the /play/:id
 * permalink page, and the /play/:id/card.svg share image.
 *
 * Follows the pages.test.ts pattern: a real Bun server over an in-memory
 * SQLite database, asserting on status codes, content types, seeded
 * markers, escaping, and empty-DB behavior.
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
import { createDatabase, insertPlays, queryPlays } from "../../storage/db";
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
    date: "2026-05-19",
    fielderId: 700001,
    fielderName: "Jac Caglianone",
    fielderPosition: "RF",
    runnerId: 543807,
    runnerName: "Nick Sogard",
    targetBase: "Home",
    batterName: "Trea Turner",
    inning: 9,
    halfInning: "top",
    awayScore: 3,
    homeScore: 1,
    awayTeam: "BOS",
    homeTeam: "KC",
    description: "Caglianone throws out Sogard at home.",
    creditChain: "RF -> C",
    tier: "high",
    outs: 2,
    runnersOn: "1st, 2nd",
    isOverturned: false,
    playId: null,
    fetchStatus: null,
    videoUrl: "https://example.com/clip.mp4",
    videoTitle: "Caglianone cuts down Sogard",
    throwVelocity: 102.7,
    throwVelocityStatus: "matched",
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

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const PLAY_CANNON = makeMockPlay();
const PLAY_CANNON_SECOND = makeMockPlay({
  gamePk: 717402,
  playIndex: 10,
  date: "2026-06-01",
  runnerId: 111111,
  runnerName: "Willi Castro",
  targetBase: "3B",
  halfInning: "bottom",
  awayTeam: "KC",
  homeTeam: "MIN",
  creditChain: "RF -> 3B",
  tier: "medium",
  throwVelocity: 88.2,
  videoUrl: null,
  videoTitle: null,
});
const PLAY_PAGES_NO_VELO = makeMockPlay({
  gamePk: 717403,
  playIndex: 5,
  date: "2026-06-10",
  fielderId: 681624,
  fielderName: "Andy Pages",
  fielderPosition: "CF",
  runnerId: 222222,
  runnerName: "Hunter Goodman",
  targetBase: "2B",
  halfInning: "bottom",
  awayTeam: "COL",
  homeTeam: "LAD",
  creditChain: "CF -> SS -> 2B",
  tier: "low",
  throwVelocity: null,
  throwVelocityStatus: null,
});
const PLAY_UNSAFE = makeMockPlay({
  gamePk: 717404,
  playIndex: 7,
  date: "2026-06-20",
  fielderId: 999001,
  fielderName: '<script>alert("x")</script> Jones',
  fielderPosition: "LF",
  runnerId: 333333,
  runnerName: 'O"Neill & <b>Sons</b>',
  targetBase: "2B",
  awayTeam: "SEA",
  homeTeam: "DET",
  creditChain: "LF -> 2B",
  tier: "high",
  throwVelocity: 91.5,
});

const ALL_PLAYS = [PLAY_CANNON, PLAY_CANNON_SECOND, PLAY_PAGES_NO_VELO, PLAY_UNSAFE];

// ---------------------------------------------------------------------------
// Seeded server
// ---------------------------------------------------------------------------

describe("cannon update pages (seeded DB)", () => {
  let db: Database;
  let server: Server<undefined>;
  let baseUrl: string;
  /** plays.id of the Caglianone cannon play, resolved after seeding. */
  let cannonPlayId: number;
  /** plays.id of the velocity-less Pages play. */
  let noVeloPlayId: number;

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
    const stored = queryPlays(db, { limit: 200 });
    cannonPlayId = stored.find((p) => p.gamePk === PLAY_CANNON.gamePk)!.id;
    noVeloPlayId = stored.find((p) => p.gamePk === PLAY_PAGES_NO_VELO.gamePk)!.id;
  });

  async function getPage(path: string): Promise<{ res: Response; body: string }> {
    const res = await fetch(`${baseUrl}${path}`);
    const body = await res.text();
    return { res, body };
  }

  // -------------------------------------------------------------------------
  // GET /season velocity sections
  // -------------------------------------------------------------------------

  describe("GET /season (velocity sections)", () => {
    test("renders the cannon rankings with fielder links and coverage notes", async () => {
      const { res, body } = await getPage("/season");
      expect(res.status).toBe(200);

      expect(body).toContain("<legend>cannon rankings</legend>");
      // Caglianone tops the board at 102.7, linked to his profile
      expect(body).toContain('href="/fielders/700001"');
      expect(body).toContain("102.7<span class=\"cannon-unit\">mph</span>");
      // avg over his two measured throws: (102.7 + 88.2) / 2 ≈ 95.4
      expect(body).toMatch(/avg 95\.\d &middot; 2 throws/);
      // coverage + small-sample honesty footnotes
      expect(body).toContain("Coverage: 3 of 4 plays");
      expect(body).toContain("can\n      rank high on a single laser");
    });

    test("renders the beeswarm with the 95 mph tier-bonus rule and table twin", async () => {
      const { body } = await getPage("/season");
      expect(body).toContain("<legend>velocity spread</legend>");
      expect(body).toContain("95 &middot; tier bonus");
      expect(body).toContain("velocity bucket");
      // min/median/max note over 88.2, 91.5, 102.7
      expect(body).toContain("Min 88.2 &middot; median 91.5 &middot; max 102.7 mph");
    });

    test("renders the arm-by-position strips without a legend", async () => {
      const { body } = await getPage("/season");
      expect(body).toContain("<legend>arm by position</legend>");
      expect(body).toContain("median mph");
    });

    test("leaderboard names link to fielder pages", async () => {
      const { body } = await getPage("/season");
      expect(body).toContain('<a class="name" href="/fielders/681624">Andy Pages</a>');
    });

    test("cannon bars never produce NaN when the max sits at the scale floor", async () => {
      // Re-seed so every measured velocity equals the 88 mph bar floor:
      // the scale range is 0 and the guard must pin bars at 100%.
      db.run("DELETE FROM plays");
      insertPlays(db, [
        makeMockPlay({ throwVelocity: 88 }),
        makeMockPlay({
          gamePk: 717409,
          playIndex: 3,
          runnerId: 444444,
          throwVelocity: 88,
        }),
      ]);
      const { res, body } = await getPage("/season");
      expect(res.status).toBe(200);
      expect(body).not.toContain("NaN");
      expect(body).toContain('cannon-bar-fill" style="width:100.0%"');
    });
  });

  // -------------------------------------------------------------------------
  // GET /fielders/:id
  // -------------------------------------------------------------------------

  describe("GET /fielders/:id", () => {
    test("renders the profile: header, tiles, panels, and recent plays", async () => {
      const { res, body } = await getPage("/fielders/700001");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");

      expect(body).toContain('<h1 class="title">Jac Caglianone</h1>');
      expect(body).toContain('<span class="pos-tag">RF</span>');
      expect(body).toContain("right field");
      expect(body).toContain("2 assists tracked");
      // rank of tracked fielders (3 distinct fielders seeded)
      expect(body).toContain("#1 of 3 fielders this season");
      // top-throw tile
      expect(body).toContain("102.7<span class=\"unit\"> mph</span>");
      expect(body).toContain("measured on 2 of 2 throws");
      // panels
      expect(body).toContain("<legend>throw map</legend>");
      expect(body).toContain("<legend>arm velocity</legend>");
      expect(body).toContain("<legend>tier mix</legend>");
      expect(body).toContain("<legend>teams burned</legend>");
      expect(body).toContain("league avg");
      // teams burned: BOS (top half away) and MIN (bottom half home)
      expect(body).toContain("BOS");
      expect(body).toContain("MIN");
      // recent plays as cards with the mph chip
      expect(body).toContain('<fieldset class="card">');
      expect(body).toContain('<span class="mph"><span class="n">102.7</span>');
    });

    test("does not uppercase-force the fielder name", async () => {
      const { body } = await getPage("/fielders/700001");
      expect(body).toContain(".profile-head .title { margin-bottom: var(--space_2xs); text-transform: none;");
    });

    test("omits the top-throw tile when no throw is measured", async () => {
      const { res, body } = await getPage("/fielders/681624");
      expect(res.status).toBe(200);
      expect(body).toContain('<h1 class="title">Andy Pages</h1>');
      expect(body).not.toContain("top throw");
      expect(body).toContain("no measured throws yet.");
    });

    test("escapes DB-sourced names", async () => {
      const { res, body } = await getPage("/fielders/999001");
      expect(res.status).toBe(200);
      expect(body).not.toContain('<script>alert("x")</script>');
      expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Jones");
    });

    test("returns the themed 404 page for an unknown fielder id", async () => {
      const { res, body } = await getPage("/fielders/424242");
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(body).toContain("nothing here");
    });

    test("returns 405 for non-GET methods", async () => {
      const res = await fetch(`${baseUrl}/fielders/700001`, { method: "POST" });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toContain("GET");
    });
  });

  // -------------------------------------------------------------------------
  // GET /play/:id
  // -------------------------------------------------------------------------

  describe("GET /play/:id", () => {
    test("renders the play card, share section, and og meta", async () => {
      const { res, body } = await getPage(`/play/${cannonPlayId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");

      expect(body).toContain('<fieldset class="card">');
      expect(body).toContain("Jac Caglianone");
      expect(body).toContain("<legend>share</legend>");
      expect(body).toContain('class="share-frame"');
      expect(body).toContain(">copy link</button>");
      // og/twitter meta with the absolute card image URL
      expect(body).toContain(
        `<meta property="og:image" content="https://janitor-bot.exe.xyz/play/${cannonPlayId}/card.svg">`,
      );
      expect(body).toContain(
        'content="Jac Caglianone (RF) cuts down Nick Sogard at home — 102.7 mph"',
      );
      expect(body).toContain('<meta name="twitter:card" content="summary_large_image">');
    });

    test("leaves the JSON API at /plays/:id untouched", async () => {
      const res = await fetch(`${baseUrl}/plays/${cannonPlayId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const play = (await res.json()) as { fielderName: string };
      expect(play.fielderName).toBe("Jac Caglianone");
    });

    test("returns the themed 404 page for an unknown play id", async () => {
      const { res, body } = await getPage("/play/999999");
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(body).toContain("nothing here");
    });

    test("returns 405 for non-GET methods", async () => {
      const res = await fetch(`${baseUrl}/play/${cannonPlayId}`, { method: "POST" });
      expect(res.status).toBe(405);
    });
  });

  // -------------------------------------------------------------------------
  // GET /play/:id/card.svg
  // -------------------------------------------------------------------------

  describe("GET /play/:id/card.svg", () => {
    test("serves a self-contained SVG with cache and CORS headers", async () => {
      const res = await fetch(`${baseUrl}/play/${cannonPlayId}/card.svg`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
      expect(res.headers.get("Cache-Control")).toContain("max-age=86400");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const body = await res.text();
      expect(body).toContain('viewBox="0 0 1200 630"');
      expect(body).toContain("Jac Caglianone");
      expect(body).toContain("102.7");
      expect(body).toContain(`/play/${cannonPlayId}`);
      // self-contained: no CSS custom-property references reach the image
      expect(body).not.toContain("var(--");
      expect(body).toContain('xmlns="http://www.w3.org/2000/svg"');
    });

    test("omits the velocity flex box when the play has no velocity", async () => {
      const res = await fetch(`${baseUrl}/play/${noVeloPlayId}/card.svg`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(">mph</text>");
    });

    test("escapes DB-sourced names inside the SVG", async () => {
      const stored = queryPlays(db, { limit: 200 });
      const unsafe = stored.find((p) => p.gamePk === PLAY_UNSAFE.gamePk)!;
      const res = await fetch(`${baseUrl}/play/${unsafe.id}/card.svg`);
      const body = await res.text();
      expect(body).not.toContain('<script>alert("x")</script>');
      expect(body).toContain("&lt;script&gt;");
    });

    test("returns 404 with CORS for an unknown play id", async () => {
      const res = await fetch(`${baseUrl}/play/999999/card.svg`);
      expect(res.status).toBe(404);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    test("returns 405 for non-GET methods", async () => {
      const res = await fetch(`${baseUrl}/play/${cannonPlayId}/card.svg`, {
        method: "POST",
      });
      expect(res.status).toBe(405);
    });
  });
});

// ---------------------------------------------------------------------------
// Empty database
// ---------------------------------------------------------------------------

describe("cannon update pages (empty DB)", () => {
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

  test("season velocity sections fall back to no-data notes", async () => {
    const res = await fetch(`${baseUrl}/season`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<legend>throw map</legend>");
    expect(body).toContain("<legend>cannon rankings</legend>");
    expect(body).not.toContain('<svg class="chart throwmap"');
    expect(body).not.toContain('class="cannon"');
  });

  test("fielder and play pages 404 cleanly", async () => {
    const fielder = await fetch(`${baseUrl}/fielders/1`);
    expect(fielder.status).toBe(404);
    const play = await fetch(`${baseUrl}/play/1`);
    expect(play.status).toBe(404);
    const card = await fetch(`${baseUrl}/play/1/card.svg`);
    expect(card.status).toBe(404);
  });
});
