/**
 * Tests for the detectOutfieldAssists function.
 *
 * Uses minimal LiveFeedResponse fixtures that satisfy the type contract
 * while only populating the fields the detection logic reads.
 */

import { test, expect, describe } from "bun:test";
import { detectOutfieldAssists, formatRunnersOn } from "../detect";
import type {
  LiveFeedResponse,
  Play,
  Runner,
  RunnerCredit,
  Position,
  LiveFeedPlayer,
} from "../../types/mlb-api";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a Position object from a code and abbreviation. */
function makePosition(code: string, abbreviation: string): Position {
  return { code, name: abbreviation, type: "Outfielder", abbreviation };
}

/**
 * Build a RunnerCredit for a fielding assist.
 *
 * @param creditType - e.g. "f_assist_of", "f_assist", "f_putout"
 * @param posCode - position code, e.g. "9" for RF
 * @param posAbbrev - position abbreviation, e.g. "RF"
 * @param playerId - numeric player ID
 */
function makeCredit(
  creditType: string,
  posCode: string,
  posAbbrev: string,
  playerId: number,
): RunnerCredit {
  return {
    player: { id: playerId },
    position: makePosition(posCode, posAbbrev),
    credit: creditType,
  };
}

/**
 * Build a Runner record with sensible defaults.
 *
 * @param overrides.isOut - Whether the runner was called out.
 * @param overrides.outBase - Base where the out was recorded.
 * @param overrides.credits - Credit chain for the play.
 * @param overrides.runnerId - Numeric player ID for the runner.
 * @param overrides.runnerName - Full name of the runner.
 */
function makeRunner(overrides: {
  isOut: boolean;
  outBase: string | null;
  credits: RunnerCredit[];
  runnerId?: number;
  runnerName?: string;
  originBase?: string | null;
}): Runner {
  return {
    movement: {
      originBase: overrides.originBase ?? "1B",
      start: overrides.originBase ?? "1B",
      end: null,
      outBase: overrides.outBase,
      isOut: overrides.isOut,
      outNumber: overrides.isOut ? 1 : 0,
    },
    details: {
      runner: {
        id: overrides.runnerId ?? 100,
        fullName: overrides.runnerName ?? "Test Runner",
      },
    },
    credits: overrides.credits,
  };
}

/**
 * Build a Play with sensible defaults. Callers can override any field.
 *
 * @param runners - Runner records for this play.
 * @param overrides - Partial overrides for play-level fields.
 */
function makePlay(
  runners: Runner[],
  overrides?: {
    inning?: number;
    halfInning?: string;
    atBatIndex?: number;
    awayScore?: number;
    homeScore?: number;
    description?: string;
    batterName?: string;
    outs?: number;
  },
): Play {
  return {
    about: {
      inning: overrides?.inning ?? 5,
      halfInning: overrides?.halfInning ?? "top",
      atBatIndex: overrides?.atBatIndex ?? 0,
    },
    result: {
      description: overrides?.description ?? "Test play description",
      awayScore: overrides?.awayScore ?? 0,
      homeScore: overrides?.homeScore ?? 0,
      event: "Field Out",
      eventType: "field_out",
    },
    matchup: {
      batter: { id: 200, fullName: overrides?.batterName ?? "Test Batter" },
    },
    runners,
    count: { outs: overrides?.outs ?? 0 },
  };
}

/**
 * Build a minimal LiveFeedResponse containing the given plays.
 *
 * Registers player IDs used in credits so resolvePlayerName can look them up.
 *
 * @param plays - Array of Play records.
 * @param extraPlayers - Additional player entries keyed by ID.
 */
function makeLiveFeed(
  plays: Play[],
  extraPlayers?: Record<number, { fullName: string; posCode: string; posAbbrev: string }>,
): LiveFeedResponse {
  const playerMap: Record<string, LiveFeedPlayer> = {};

  // Register any players passed explicitly.
  if (extraPlayers) {
    for (const [idStr, info] of Object.entries(extraPlayers)) {
      const id = Number(idStr);
      playerMap[`ID${id}`] = {
        id,
        fullName: info.fullName,
        primaryPosition: makePosition(info.posCode, info.posAbbrev),
      };
    }
  }

  // Auto-register players found in credit chains so name resolution works.
  for (const play of plays) {
    for (const runner of play.runners) {
      for (const credit of runner.credits ?? []) {
        const pid = credit.player.id;
        if (!playerMap[`ID${pid}`]) {
          playerMap[`ID${pid}`] = {
            id: pid,
            fullName: `Player ${pid}`,
            primaryPosition: credit.position,
          };
        }
      }
    }
  }

  return {
    gameData: {
      teams: {
        away: { id: 1, name: "Away Team", abbreviation: "AWY", teamName: "Away" },
        home: { id: 2, name: "Home Team", abbreviation: "HME", teamName: "Home" },
      },
      players: playerMap,
    },
    liveData: {
      plays: { allPlays: plays },
      boxscore: {
        teams: {
          away: { players: {} },
          home: { players: {} },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectOutfieldAssists", () => {
  test("detects a single outfield assist", () => {
    const credits = [
      makeCredit("f_assist_of", "9", "RF", 500),
      makeCredit("f_putout", "2", "C", 501),
    ];
    const runner = makeRunner({ isOut: true, outBase: "Home", credits });
    const play = makePlay([runner]);
    const feed = makeLiveFeed([play], {
      500: { fullName: "Ichiro Suzuki", posCode: "9", posAbbrev: "RF" },
    });

    const results = detectOutfieldAssists(feed, 12345, "2025-06-15");

    expect(results).toHaveLength(1);
    expect(results[0].gamePk).toBe(12345);
    expect(results[0].date).toBe("2025-06-15");
    expect(results[0].fielderId).toBe(500);
    expect(results[0].fielderName).toBe("Ichiro Suzuki");
    expect(results[0].fielderPosition).toBe("RF");
    expect(results[0].runnerId).toBe(100);
    expect(results[0].runnerName).toBe("Test Runner");
    expect(results[0].targetBase).toBe("Home");
    expect(results[0].awayTeam).toBe("AWY");
    expect(results[0].homeTeam).toBe("HME");
    expect(results[0].videoUrl).toBeNull();
    expect(results[0].videoTitle).toBeNull();
  });

  test("ignores non-outfield assist credits (infielder position code)", () => {
    const credits = [
      makeCredit("f_assist", "4", "2B", 600),
      makeCredit("f_putout", "3", "1B", 601),
    ];
    const runner = makeRunner({ isOut: true, outBase: "2B", credits });
    const play = makePlay([runner]);
    const feed = makeLiveFeed([play]);

    const results = detectOutfieldAssists(feed, 12345, "2025-06-15");
    expect(results).toHaveLength(0);
  });

  test("ignores runner who is not out even with outfield assist credit", () => {
    const credits = [
      makeCredit("f_assist_of", "9", "RF", 500),
      makeCredit("f_putout", "2", "C", 501),
    ];
    const runner = makeRunner({ isOut: false, outBase: null, credits });
    const play = makePlay([runner]);
    const feed = makeLiveFeed([play]);

    const results = detectOutfieldAssists(feed, 12345, "2025-06-15");
    expect(results).toHaveLength(0);
  });

  test("detects multiple outfield assists in one game", () => {
    // First play: RF throws out runner at home
    const credits1 = [
      makeCredit("f_assist_of", "9", "RF", 500),
      makeCredit("f_putout", "2", "C", 501),
    ];
    const runner1 = makeRunner({
      isOut: true,
      outBase: "Home",
      credits: credits1,
      runnerId: 100,
      runnerName: "Runner One",
    });
    const play1 = makePlay([runner1], { atBatIndex: 10 });

    // Second play: CF throws out runner at 3B
    const credits2 = [
      makeCredit("f_assist_of", "8", "CF", 502),
      makeCredit("f_putout", "5", "3B", 503),
    ];
    const runner2 = makeRunner({
      isOut: true,
      outBase: "3B",
      credits: credits2,
      runnerId: 101,
      runnerName: "Runner Two",
    });
    const play2 = makePlay([runner2], { atBatIndex: 25 });

    const feed = makeLiveFeed([play1, play2]);

    const results = detectOutfieldAssists(feed, 99999, "2025-07-04");

    expect(results).toHaveLength(2);
    expect(results[0].fielderPosition).toBe("RF");
    expect(results[0].targetBase).toBe("Home");
    expect(results[0].playIndex).toBe(10);
    expect(results[1].fielderPosition).toBe("CF");
    expect(results[1].targetBase).toBe("3B");
    expect(results[1].playIndex).toBe(25);
  });

  test("normalizes outBase '4B' to 'Home'", () => {
    // Some MLB live-feed events report plate-out plays with outBase "4B"
    // instead of "score" or "Home". The normalizer must collapse all three
    // so downstream consumers see a single label.
    const credits = [
      makeCredit("f_assist_of", "9", "RF", 500),
      makeCredit("f_putout", "2", "C", 501),
    ];
    const runner = makeRunner({ isOut: true, outBase: "4B", credits });
    const play = makePlay([runner]);
    const feed = makeLiveFeed([play]);

    const results = detectOutfieldAssists(feed, 12345, "2025-06-15");

    expect(results).toHaveLength(1);
    expect(results[0].targetBase).toBe("Home");
  });

  test("builds credit chain from all credits on the runner", () => {
    // RF -> SS -> C relay chain
    const credits = [
      makeCredit("f_assist_of", "9", "RF", 500),
      makeCredit("f_assist", "6", "SS", 502),
      makeCredit("f_putout", "2", "C", 501),
    ];
    const runner = makeRunner({ isOut: true, outBase: "Home", credits });
    const play = makePlay([runner]);
    const feed = makeLiveFeed([play]);

    const results = detectOutfieldAssists(feed, 12345, "2025-06-15");

    expect(results).toHaveLength(1);
    expect(results[0].creditChain).toBe("RF -> SS -> C");
  });

  test("deduplicates consecutive positions in credit chain", () => {
    const credits = [
      makeCredit("f_assist_of", "8", "CF", 500),
      makeCredit("f_assist", "8", "CF", 500),
      makeCredit("f_assist", "6", "SS", 502),
      makeCredit("f_putout", "5", "3B", 503),
    ];
    const runner = makeRunner({ isOut: true, outBase: "3B", credits });
    const play = makePlay([runner]);
    const feed = makeLiveFeed([play]);

    const results = detectOutfieldAssists(feed, 12345, "2025-06-15");

    expect(results).toHaveLength(1);
    expect(results[0].creditChain).toBe("CF -> SS -> 3B");
  });

  test("preserves non-consecutive duplicate positions in credit chain", () => {
    const credits = [
      makeCredit("f_assist_of", "8", "CF", 500),
      makeCredit("f_assist", "6", "SS", 502),
      makeCredit("f_putout", "8", "CF", 500),
    ];
    const runner = makeRunner({ isOut: true, outBase: "3B", credits });
    const play = makePlay([runner]);
    const feed = makeLiveFeed([play]);

    const results = detectOutfieldAssists(feed, 12345, "2025-06-15");

    expect(results).toHaveLength(1);
    expect(results[0].creditChain).toBe("CF -> SS -> CF");
  });

  test("extracts outs from play.count", () => {
    const credits = [
      makeCredit("f_assist_of", "9", "RF", 500),
      makeCredit("f_putout", "2", "C", 501),
    ];
    const runner = makeRunner({ isOut: true, outBase: "Home", credits });
    const play = makePlay([runner], { outs: 1 });
    const feed = makeLiveFeed([play]);

    const results = detectOutfieldAssists(feed, 12345, "2025-06-15");

    expect(results).toHaveLength(1);
    expect(results[0].outs).toBe(1);
  });

  test("defaults outs to 0 when play.count is missing", () => {
    const credits = [
      makeCredit("f_assist_of", "9", "RF", 500),
      makeCredit("f_putout", "2", "C", 501),
    ];
    const runner = makeRunner({ isOut: true, outBase: "Home", credits });
    const play = makePlay([runner]);
    delete play.count;
    const feed = makeLiveFeed([play]);

    const results = detectOutfieldAssists(feed, 12345, "2025-06-15");

    expect(results).toHaveLength(1);
    expect(results[0].outs).toBe(0);
  });

  test("extracts runnersOn from runner originBase values", () => {
    const credits = [
      makeCredit("f_assist_of", "9", "RF", 500),
      makeCredit("f_putout", "2", "C", 501),
    ];
    const thrownOutRunner = makeRunner({
      isOut: true,
      outBase: "Home",
      credits,
      runnerId: 100,
      originBase: "3B",
    });
    // Batter has null originBase and is not out
    const batter: Runner = {
      movement: {
        originBase: null,
        start: null,
        end: "1B",
        outBase: null,
        isOut: false,
        outNumber: 0,
      },
      details: { runner: { id: 201, fullName: "Batter" } },
    };
    // Another runner on 1B
    const otherRunner: Runner = {
      movement: {
        originBase: "1B",
        start: "1B",
        end: "2B",
        outBase: null,
        isOut: false,
        outNumber: 0,
      },
      details: { runner: { id: 202, fullName: "Other Runner" } },
    };
    const play = makePlay([thrownOutRunner, batter, otherRunner]);
    const feed = makeLiveFeed([play]);

    const results = detectOutfieldAssists(feed, 12345, "2025-06-15");

    expect(results).toHaveLength(1);
    expect(results[0].runnersOn).toBe("1st, 3rd");
  });
});

// ---------------------------------------------------------------------------
// formatRunnersOn
// ---------------------------------------------------------------------------

describe("formatRunnersOn", () => {
  test("returns empty string with no runners", () => {
    expect(formatRunnersOn([])).toBe("");
  });

  test("returns empty string when all originBase values are null", () => {
    const runners: Runner[] = [
      {
        movement: { originBase: null, start: null, end: "1B", outBase: null, isOut: false, outNumber: 0 },
        details: { runner: { id: 1, fullName: "Batter" } },
      },
    ];
    expect(formatRunnersOn(runners)).toBe("");
  });

  test("formats single runner on 1st", () => {
    const runners: Runner[] = [
      {
        movement: { originBase: "1B", start: "1B", end: "2B", outBase: null, isOut: false, outNumber: 0 },
        details: { runner: { id: 1, fullName: "Runner" } },
      },
    ];
    expect(formatRunnersOn(runners)).toBe("1st");
  });

  test("formats runners on 1st and 3rd in order", () => {
    const runners: Runner[] = [
      {
        movement: { originBase: "3B", start: "3B", end: null, outBase: "Home", isOut: true, outNumber: 1 },
        details: { runner: { id: 1, fullName: "Runner A" } },
      },
      {
        movement: { originBase: "1B", start: "1B", end: "2B", outBase: null, isOut: false, outNumber: 0 },
        details: { runner: { id: 2, fullName: "Runner B" } },
      },
    ];
    expect(formatRunnersOn(runners)).toBe("1st, 3rd");
  });

  test("formats bases loaded", () => {
    const runners: Runner[] = [
      {
        movement: { originBase: "2B", start: "2B", end: "3B", outBase: null, isOut: false, outNumber: 0 },
        details: { runner: { id: 1, fullName: "Runner A" } },
      },
      {
        movement: { originBase: "1B", start: "1B", end: "2B", outBase: null, isOut: false, outNumber: 0 },
        details: { runner: { id: 2, fullName: "Runner B" } },
      },
      {
        movement: { originBase: "3B", start: "3B", end: null, outBase: null, isOut: false, outNumber: 0 },
        details: { runner: { id: 3, fullName: "Runner C" } },
      },
    ];
    expect(formatRunnersOn(runners)).toBe("1st, 2nd, 3rd");
  });

  test("deduplicates bases when multiple runners share an originBase", () => {
    const runners: Runner[] = [
      {
        movement: { originBase: "1B", start: "1B", end: "2B", outBase: null, isOut: false, outNumber: 0 },
        details: { runner: { id: 1, fullName: "Runner A" } },
      },
      {
        movement: { originBase: "1B", start: "1B", end: null, outBase: "2B", isOut: true, outNumber: 1 },
        details: { runner: { id: 2, fullName: "Runner B" } },
      },
    ];
    expect(formatRunnersOn(runners)).toBe("1st");
  });
});
