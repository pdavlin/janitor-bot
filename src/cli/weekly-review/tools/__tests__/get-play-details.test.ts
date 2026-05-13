import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../../../storage/db";
import { getPlayDetails } from "../get-play-details";
import type { DetectedPlay } from "../../../../types/play";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

function makePlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 200,
    playIndex: 4,
    date: "2026-04-30",
    fielderId: 7,
    fielderName: "Mookie Betts",
    fielderPosition: "RF",
    runnerId: 1,
    runnerName: "R",
    targetBase: "Home",
    batterName: "B",
    inning: 8,
    halfInning: "bot",
    awayScore: 3,
    homeScore: 2,
    awayTeam: "LAD",
    homeTeam: "SFG",
    description: "RF -> Home",
    creditChain: "RF -> C",
    tier: "high",
    outs: 2,
    runnersOn: "1st_2nd",
    isOverturned: false,
    playId: null,
    fetchStatus: "success",
    videoUrl: "https://savant.example/clip.mp4",
    videoTitle: "Great throw",
    ...overrides,
  };
}

function getInsertedPlayId(db: Database): number {
  const row = db.prepare("SELECT id FROM plays ORDER BY id DESC LIMIT 1;").get() as { id: number };
  return row.id;
}

describe("getPlayDetails", () => {
  test("returns every documented field", () => {
    insertPlay(db, makePlay());
    const playId = getInsertedPlayId(db);
    const result = getPlayDetails(db, playId);

    expect(result).toEqual({
      playId,
      date: "2026-04-30",
      tier: "high",
      position: "RF",
      targetBase: "Home",
      runnersOn: "1st_2nd",
      creditChain: "RF -> C",
      hasVideo: true,
      fetchStatus: "success",
      awayTeam: "LAD",
      homeTeam: "SFG",
      inning: 8,
      halfInning: "bot",
      outs: 2,
      gamePk: 200,
      playIndex: 4,
    });
  });

  test("hasVideo is false when video_url is null", () => {
    insertPlay(db, makePlay({ videoUrl: null }));
    const playId = getInsertedPlayId(db);
    const result = getPlayDetails(db, playId);

    if ("error" in result) throw new Error("expected play to exist");
    expect(result.hasVideo).toBe(false);
  });

  test("returns not_found for unknown id", () => {
    expect(getPlayDetails(db, 9999)).toEqual({ error: "not_found" });
  });

  test("does not return raw video_url or descriptive prose", () => {
    insertPlay(db, makePlay());
    const playId = getInsertedPlayId(db);
    const result = getPlayDetails(db, playId);

    expect(result).not.toHaveProperty("video_url");
    expect(result).not.toHaveProperty("videoUrl");
    expect(result).not.toHaveProperty("description");
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("message");
    expect(result).not.toHaveProperty("transcript");
    expect(result).not.toHaveProperty("matched_text");
  });
});
