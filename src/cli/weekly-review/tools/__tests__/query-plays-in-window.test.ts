import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../../../storage/db";
import { queryPlaysInWindow } from "../query-plays-in-window";
import type { DetectedPlay } from "../../../../types/play";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

function makePlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 100,
    playIndex: 1,
    date: "2026-04-28",
    fielderId: 7,
    fielderName: "Mookie Betts",
    fielderPosition: "RF",
    runnerId: 1,
    runnerName: "R",
    targetBase: "Home",
    batterName: "B",
    inning: 7,
    halfInning: "top",
    awayScore: 3,
    homeScore: 2,
    awayTeam: "LAD",
    homeTeam: "SFG",
    description: "throw",
    creditChain: "RF -> C",
    tier: "high",
    outs: 1,
    runnersOn: "1st",
    isOverturned: false,
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

const WINDOW = { weekStarting: "2026-04-26", weekEnding: "2026-05-02" };

describe("queryPlaysInWindow", () => {
  test("returns plays within the window with expected shape", () => {
    insertPlay(db, makePlay({ playIndex: 1 }));
    insertPlay(db, makePlay({ playIndex: 2, runnerId: 2 }));

    const result = queryPlaysInWindow(db, WINDOW);
    expect(result.count).toBe(2);
    expect(result.filters).toEqual(WINDOW);
    expect(result.plays[0]).toMatchObject({
      gamePk: 100,
      playIndex: 1,
      date: "2026-04-28",
      tier: "high",
      position: "RF",
      targetBase: "Home",
      runnersOn: "1st",
      hasVideo: false,
    });
  });

  test("excludes plays outside the date range", () => {
    insertPlay(db, makePlay({ playIndex: 1, date: "2026-04-25" }));
    insertPlay(db, makePlay({ playIndex: 2, runnerId: 2, date: "2026-05-03" }));
    insertPlay(db, makePlay({ playIndex: 3, runnerId: 3, date: "2026-04-28" }));

    const result = queryPlaysInWindow(db, WINDOW);
    expect(result.count).toBe(1);
    expect(result.plays[0]?.playIndex).toBe(3);
  });

  test("AND-combines filters", () => {
    insertPlay(db, makePlay({ playIndex: 1, fielderPosition: "RF", targetBase: "Home" }));
    insertPlay(db, makePlay({ playIndex: 2, runnerId: 2, fielderPosition: "CF", targetBase: "Home" }));
    insertPlay(db, makePlay({ playIndex: 3, runnerId: 3, fielderPosition: "RF", targetBase: "3B" }));

    const result = queryPlaysInWindow(db, {
      ...WINDOW,
      position: "RF",
      targetBase: "Home",
    });
    expect(result.count).toBe(1);
    expect(result.plays[0]?.playIndex).toBe(1);
  });

  test("hasVideo true filters to plays with a video URL", () => {
    insertPlay(db, makePlay({ playIndex: 1, videoUrl: "https://savant.example/clip.mp4" }));
    insertPlay(db, makePlay({ playIndex: 2, runnerId: 2, videoUrl: null }));

    const result = queryPlaysInWindow(db, { ...WINDOW, hasVideo: true });
    expect(result.count).toBe(1);
    expect(result.plays[0]?.hasVideo).toBe(true);
  });

  test("caps results at 200 rows", () => {
    for (let i = 1; i <= 250; i++) {
      insertPlay(db, makePlay({ playIndex: i, runnerId: i }));
    }
    const result = queryPlaysInWindow(db, WINDOW);
    expect(result.count).toBe(200);
    expect(result.plays.length).toBe(200);
  });

  test("does not return any prose or transcript fields", () => {
    insertPlay(db, makePlay());
    const result = queryPlaysInWindow(db, WINDOW);
    for (const play of result.plays) {
      expect(play).not.toHaveProperty("description");
      expect(play).not.toHaveProperty("text");
      expect(play).not.toHaveProperty("message");
      expect(play).not.toHaveProperty("transcript");
      expect(play).not.toHaveProperty("matched_text");
    }
  });
});
