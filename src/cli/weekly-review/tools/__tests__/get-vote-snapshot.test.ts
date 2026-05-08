import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../../../storage/db";
import { getVoteSnapshot } from "../get-vote-snapshot";
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
    description: "RF -> Home",
    creditChain: "RF -> C",
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

function getInsertedPlayId(db: Database): number {
  const row = db.prepare("SELECT id FROM plays ORDER BY id DESC LIMIT 1;").get() as { id: number };
  return row.id;
}

describe("getVoteSnapshot", () => {
  test("returns counts when a snapshot row exists", () => {
    insertPlay(db, makePlay());
    const playId = getInsertedPlayId(db);
    db.prepare(
      `INSERT INTO vote_snapshots (game_pk, play_index, fire_count, trash_count, net_score, voter_count, snapshotted_at)
       VALUES (100, 1, 5, 2, 3, 7, datetime('now'));`,
    ).run();

    const result = getVoteSnapshot(db, playId);
    expect(result).toEqual({
      playId,
      gamePk: 100,
      playIndex: 1,
      fireCount: 5,
      trashCount: 2,
      voterCount: 7,
      netScore: 3,
    });
  });

  test("returns zeros when the play exists but no snapshot row exists", () => {
    insertPlay(db, makePlay());
    const playId = getInsertedPlayId(db);

    const result = getVoteSnapshot(db, playId);
    expect(result).toEqual({
      playId,
      gamePk: 100,
      playIndex: 1,
      fireCount: 0,
      trashCount: 0,
      voterCount: 0,
      netScore: 0,
    });
  });

  test("returns not_found when the play does not exist", () => {
    expect(getVoteSnapshot(db, 9999)).toEqual({ error: "not_found" });
  });

  test("never includes a text or message field", () => {
    insertPlay(db, makePlay());
    const playId = getInsertedPlayId(db);
    const result = getVoteSnapshot(db, playId);
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("message");
    expect(result).not.toHaveProperty("transcript");
    expect(result).not.toHaveProperty("matched_text");
  });
});
