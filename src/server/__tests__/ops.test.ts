/**
 * Integration tests for the /ops page (website batch 2).
 *
 * Starts a real Bun server against an in-memory SQLite database seeded
 * with plays, votes, vote_snapshots, and play_rematch_events fixtures, and
 * asserts the page renders both sections with the expected markers, that
 * DB-sourced strings are escaped, that an empty database renders sane
 * empty states, that /ops stays out of the nav, and that non-GET methods
 * get 405 (known-route semantics).
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
    fetchStatus: "success",
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

/** Most-loved candidate (net +3), also the fetch_status=success play. */
const PLAY_LOVED = makeMockPlay();
/** Flagged for tier review, fetch_status pre-dates the column (NULL). */
const PLAY_FLAGGED = makeMockPlay({
  gamePk: 717402,
  playIndex: 10,
  date: "2026-06-22",
  fielderId: 671213,
  fielderName: "Wilyer Abreu",
  fielderPosition: "RF",
  runnerName: "Willi Castro",
  targetBase: "3B",
  halfInning: "top",
  awayTeam: "BOS",
  homeTeam: "COL",
  creditChain: "RF -> 3B",
  tier: "medium",
  fetchStatus: null,
  videoUrl: null,
  videoTitle: null,
  runnersOn: "",
});
/** Overturned, video lookup found nothing, velocity lookup no-match. */
const PLAY_OVERTURNED = makeMockPlay({
  gamePk: 717403,
  playIndex: 5,
  date: "2026-06-21",
  fielderId: 691718,
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
  fetchStatus: "no_video_found",
  videoUrl: null,
  videoTitle: null,
  throwVelocityStatus: "no_match",
});
/** Hostile strings; drawn into the most-loved list via a +2 snapshot. */
const PLAY_UNSAFE_NAME = makeMockPlay({
  gamePk: 717404,
  playIndex: 7,
  date: "2026-06-20",
  fielderId: 999001,
  fielderName: '<script>alert("x")</script> Jones',
  runnerName: 'O"Neill & <b>Sons</b>',
  awayTeam: "SEA",
  homeTeam: "DET",
  creditChain: "CF -> C",
  tier: "high",
  fetchStatus: null,
  videoUrl: null,
  videoTitle: null,
});

const ALL_PLAYS = [PLAY_LOVED, PLAY_FLAGGED, PLAY_OVERTURNED, PLAY_UNSAFE_NAME];

/** Inserts one raw votes row (reaction event). */
function insertVote(
  db: Database,
  userId: string,
  gamePk: number,
  playIndex: number,
  direction: "fire" | "trash",
  action: "added" | "removed" = "added",
): void {
  db.run(
    `INSERT INTO votes (user_id, game_pk, play_index, direction, action, event_ts, received_at)
     VALUES (?, ?, ?, ?, ?, '1750000000.000100', '2026-06-23T12:00:00Z');`,
    [userId, gamePk, playIndex, direction, action],
  );
}

/** Inserts one vote_snapshots row (settled per-play tally). */
function insertSnapshot(
  db: Database,
  gamePk: number,
  playIndex: number,
  fire: number,
  trash: number,
  voterCount: number,
  flagged = false,
  reason: string | null = null,
): void {
  db.run(
    `INSERT INTO vote_snapshots
       (game_pk, play_index, fire_count, trash_count, net_score, voter_count,
        snapshotted_at, tier_review_flagged, tier_review_reason)
     VALUES (?, ?, ?, ?, ?, ?, '2026-06-23T18:00:00Z', ?, ?);`,
    [gamePk, playIndex, fire, trash, fire - trash, voterCount, flagged ? 1 : 0, reason],
  );
}

/** Inserts one play_rematch_events row. */
function insertRematchEvent(
  db: Database,
  gamePk: number,
  playIndex: number,
  decision: string,
): void {
  db.run(
    `INSERT INTO play_rematch_events (game_pk, play_index, user_id, decision, event_ts)
     VALUES (?, ?, 'U001', ?, '1750000000.000200');`,
    [gamePk, playIndex, decision],
  );
}

function seedOpsFixtures(db: Database): void {
  insertPlays(db, ALL_PLAYS);

  // 6 vote events across 2 voters (one add later removed).
  insertVote(db, "U001", PLAY_LOVED.gamePk, PLAY_LOVED.playIndex, "fire");
  insertVote(db, "U002", PLAY_LOVED.gamePk, PLAY_LOVED.playIndex, "fire");
  insertVote(db, "U001", PLAY_UNSAFE_NAME.gamePk, PLAY_UNSAFE_NAME.playIndex, "fire");
  insertVote(db, "U002", PLAY_FLAGGED.gamePk, PLAY_FLAGGED.playIndex, "trash");
  insertVote(db, "U001", PLAY_FLAGGED.gamePk, PLAY_FLAGGED.playIndex, "trash");
  insertVote(db, "U001", PLAY_FLAGGED.gamePk, PLAY_FLAGGED.playIndex, "trash", "removed");

  // Snapshots: fire 5 / trash 2 total; 3 of 4 plays drew voters.
  insertSnapshot(db, PLAY_LOVED.gamePk, PLAY_LOVED.playIndex, 3, 0, 3);
  insertSnapshot(db, PLAY_UNSAFE_NAME.gamePk, PLAY_UNSAFE_NAME.playIndex, 2, 0, 2);
  insertSnapshot(
    db,
    PLAY_FLAGGED.gamePk,
    PLAY_FLAGGED.playIndex,
    0,
    2,
    2,
    true,
    "channel_disagrees_high_or_medium",
  );
  insertSnapshot(db, PLAY_OVERTURNED.gamePk, PLAY_OVERTURNED.playIndex, 0, 0, 0);

  // Rematch/angle decisions: 2 angle_found, 1 swapped, 1 no_match, and
  // 1 agreed (a confirmation — must not be lumped with "nothing found").
  insertRematchEvent(db, PLAY_LOVED.gamePk, PLAY_LOVED.playIndex, "angle_found");
  insertRematchEvent(db, PLAY_LOVED.gamePk, PLAY_LOVED.playIndex, "angle_found");
  insertRematchEvent(db, PLAY_FLAGGED.gamePk, PLAY_FLAGGED.playIndex, "swapped");
  insertRematchEvent(db, PLAY_OVERTURNED.gamePk, PLAY_OVERTURNED.playIndex, "no_match");
  insertRematchEvent(db, PLAY_LOVED.gamePk, PLAY_LOVED.playIndex, "agreed");
}

// ---------------------------------------------------------------------------
// Seeded server
// ---------------------------------------------------------------------------

describe("GET /ops (seeded DB)", () => {
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
    db.run("DELETE FROM votes");
    db.run("DELETE FROM vote_snapshots");
    db.run("DELETE FROM play_rematch_events");
    seedOpsFixtures(db);
  });

  async function getPage(path: string): Promise<{ res: Response; body: string }> {
    const res = await fetch(`${baseUrl}${path}`);
    const body = await res.text();
    return { res, body };
  }

  test("renders both sections with engagement totals", async () => {
    const { res, body } = await getPage("/ops");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    expect(body).toContain("<legend>engagement</legend>");
    expect(body).toContain("<legend>pipeline health</legend>");
    expect(body).toContain("vote engagement and pipeline health");

    // Tiles: 5 votes cast (the removal event is not a vote cast),
    // 3 plays voted on of 4 snapshots, 2 voters.
    expect(body).toContain("<legend>votes cast</legend>");
    expect(body).toContain(">5</span>");
    expect(body).not.toContain(">6</span>");
    expect(body).toContain("settled across 3 plays");
    expect(body).toContain("<legend>plays voted on</legend>");
    expect(body).toContain("of 4 tier-review snapshots taken");
    expect(body).toContain("<legend>distinct voters</legend>");
    expect(body).toContain("small n, read signal loosely");
  });

  test("renders the most-loved list ordered by net score with tallies", async () => {
    const { body } = await getPage("/ops");
    expect(body).toContain("most loved &middot; top net score");
    // Two positive-net snapshots -> two rows; zero/negative nets excluded.
    expect(countOf(body, '<span class="rk">')).toBe(2);
    expect(body).toContain("Andy Pages");
    expect(body).not.toContain("Chandler Simpson");
    // Net-3 play ranks first.
    expect(body.indexOf("Andy Pages")).toBeLessThan(body.indexOf("Jones"));
    // Tally + context markers (shared playHeadline fragment).
    expect(body).toContain('<span class="net">+3</span>');
    expect(body).toContain('cut down</span> <span class="runner">Austin Martin</span>');
    expect(body).toContain("CF -&gt; SS -&gt; C");
    expect(body).toContain("LAD @ MIN");
  });

  test("renders the disputed list with tier badge, negative net, and reason", async () => {
    const { body } = await getPage("/ops");
    expect(body).toContain("disputed &middot; flagged for tier review (1)");
    expect(body).toContain("Wilyer Abreu");
    expect(body).toContain('<span class="net">−2</span>');
    expect(body).toContain("channel disagrees — voted down a high/medium tier &middot; 2 voters");
  });

  test("uses the lowest-runner_id row on a multi-runner (double play) snapshot", async () => {
    // Two runner rows share (game_pk, play_index). The higher runner_id
    // inserts first so rowid order disagrees with runner_id order: a
    // MIN(id) join would show Runner B's row; the deterministic
    // MIN(runner_id) representative (matching snapshot-job's tier SELECT)
    // must show Runner A's.
    const shared = { gamePk: 900001, playIndex: 3, fetchStatus: null, videoUrl: null, videoTitle: null };
    insertPlays(db, [
      makeMockPlay({ ...shared, runnerId: 700200, runnerName: "Runner B", tier: "low" }),
      makeMockPlay({ ...shared, runnerId: 700100, runnerName: "Runner A", tier: "medium" }),
    ]);
    insertSnapshot(db, 900001, 3, 0, 2, 2, true, "channel_disagrees_high_or_medium");

    const { body } = await getPage("/ops");
    expect(body).toContain("disputed &middot; flagged for tier review (2)");
    // One disputed row for the play, from the runner_id 700100 record.
    expect(body).toContain("Runner A");
    expect(body).not.toContain("Runner B");
    // Its tier badge comes from the same representative row (medium, not
    // the first-inserted low row): PLAY_FLAGGED plus this one.
    expect(countOf(body, "tier tier-medium")).toBe(2);
  });

  test("renders the fetch-status chart with its data-table twin", async () => {
    const { body } = await getPage("/ops");
    expect(body).toContain("video fetch status &middot; 4 plays");
    expect(body).toContain('<svg class="chart"');
    // NULL rows bucketed as unfetched, named explicitly in the table.
    expect(body).toContain("unfetched (null)");
    expect(body).toContain("no_video_found");
    expect(body).toContain("data table");
    expect(body).toContain("the 2 unfetched pre-date the fetch_status column");
    expect(body).toContain("1 of 4 plays carry a video link");
    // Tooltip enhancement present.
    expect(body).toContain('id="tt"');
    expect(body).toContain('querySelectorAll(".mark")');
  });

  test("renders rematch decision counts with color-classed bars", async () => {
    const { body } = await getPage("/ops");
    expect(body).toContain("rematch &amp; angle decisions &middot; 5 events");
    expect(body).toContain('<li class="dec-found">');
    expect(body).toContain('<li class="dec-swap">');
    expect(body).toContain('<li class="dec-none">');
    expect(body).toContain("angle found");
    expect(body).toContain("no match");
    // 'agreed' is a confirmation: teal class, not the grey not-found bucket.
    expect(body).toContain("agreed");
    expect(countOf(body, '<li class="dec-found">')).toBe(2);
    // angle_found (2) is the max -> full-width bar.
    expect(body).toContain('style="width:100.0%"');
  });

  test("derives the legend from the decisions actually present", async () => {
    const { body } = await getPage("/ops");
    // One legend line per present decision, colored by its meaning.
    expect(body).toContain("a better angle was posted");
    expect(body).toContain("original clip replaced");
    expect(body).toContain("nothing found");
    expect(body).toContain("agent confirmed the original clip");
    // Decisions absent from the data contribute no legend line.
    expect(body).not.toContain("duplicate request, no action");
    expect(body).not.toContain("no other camera angle available");
    expect(body).not.toContain("angle lookup failed");
  });

  test("renders the pipeline totals tiles honestly", async () => {
    const { body } = await getPage("/ops");
    expect(body).toContain("<legend>overturned plays</legend>");
    expect(body).toContain("<legend>throw velocity</legend>");
    expect(body).toContain("statcast velo not yet backfilled · 1 lookup, all no-match");
    expect(body).toContain("<legend>tracked plays</legend>");
    expect(body).toContain("4 games · high 2 · medium 1 · low 1");
    expect(body).toContain("4 plays across 4 games");
  });

  test("escapes hostile DB strings in the most-loved row", async () => {
    const { body } = await getPage("/ops");
    expect(body).not.toContain('<script>alert("x")</script>');
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Jones");
    expect(body).not.toContain("<b>Sons</b>");
  });

  test("stays out of the header nav", async () => {
    const { body } = await getPage("/ops");
    expect(body).not.toContain('href="/ops"');
    // The four batch-1 nav links are still present.
    for (const href of ["/", "/highlights", "/season", "/about"]) {
      expect(body).toContain(`href="${href}"`);
    }
    // No nav item is marked current on this unlinked page.
    expect(body).not.toContain('aria-current="page"');
  });

  test("returns 405 with Allow on POST /ops (known route)", async () => {
    const res = await fetch(`${baseUrl}/ops`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, OPTIONS");
    const bodyJson = (await res.json()) as { error: string };
    expect(bodyJson.error).toBe("Method not allowed");
  });
});

// ---------------------------------------------------------------------------
// Empty database
// ---------------------------------------------------------------------------

describe("GET /ops (empty DB)", () => {
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

  test("renders zeros and empty states instead of failing", async () => {
    const res = await fetch(`${baseUrl}/ops`);
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain("<legend>engagement</legend>");
    expect(body).toContain("<legend>pipeline health</legend>");
    expect(body).toContain("0 plays across 0 games");
    expect(body).toContain(">0</span>");
    expect(body).toContain("no plays with a positive net score yet.");
    expect(body).toContain("nothing flagged for tier review.");
    expect(body).toContain("no plays tracked yet.");
    expect(body).toContain("no rematch or angle requests yet.");
    expect(body).toContain("statcast velo not yet backfilled");
    expect(body).not.toContain('<svg class="chart"');
  });
});

// ---------------------------------------------------------------------------
// HTML error handling
// ---------------------------------------------------------------------------

describe("GET /ops error handling", () => {
  test("returns the themed 500 page, not JSON, when the DB is broken", async () => {
    const db = createDatabase(":memory:");
    const server = startServer({
      db,
      dbPath: ":memory:",
      logger: makeSilentLogger(),
      port: 0,
      getSchedulerStatus: makeSchedulerStatus,
    });
    db.close();

    try {
      const res = await fetch(`http://localhost:${server.port}/ops`);
      expect(res.status).toBe(500);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(await res.text()).toContain("something broke");
    } finally {
      server.stop(true);
    }
  });
});
