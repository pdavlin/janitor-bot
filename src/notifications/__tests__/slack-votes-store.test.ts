/**
 * Tests for slack-votes-store: insert + tally semantics for the append-only
 * vote log. Uses an in-memory DB so the actual schema and constraints are
 * exercised, not mocked.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../storage/db";
import { recordPlayMessage } from "../slack-messages-store";
import {
  insertVoteEvent,
  computePlayTally,
  reactionToDirection,
  isPostWindow,
  type VoteDirection,
  type VoteAction,
} from "../slack-votes-store";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

function vote(
  userId: string,
  direction: VoteDirection,
  action: VoteAction,
  postWindow = false,
): void {
  insertVoteEvent(db, {
    userId,
    gamePk: 1,
    playIndex: 1,
    direction,
    action,
    eventTs: "0",
    postWindow,
  });
}

describe("reactionToDirection", () => {
  test("maps :fire: to fire", () => {
    expect(reactionToDirection("fire")).toBe("fire");
  });

  test("maps :wastebasket: to trash", () => {
    expect(reactionToDirection("wastebasket")).toBe("trash");
  });

  test("returns null for unmapped reactions", () => {
    expect(reactionToDirection("thumbsup")).toBeNull();
    expect(reactionToDirection("heart")).toBeNull();
  });
});

describe("insertVoteEvent", () => {
  test("writes a row that reads back via raw SQL", () => {
    insertVoteEvent(db, {
      userId: "U1",
      gamePk: 100,
      playIndex: 5,
      direction: "fire",
      action: "added",
      eventTs: "1700000000.000200",
      postWindow: false,
    });
    const row = db.prepare("SELECT * FROM votes").get() as {
      user_id: string;
      game_pk: number;
      play_index: number;
      direction: string;
      action: string;
      event_ts: string;
      post_window: number;
    };
    expect(row).toMatchObject({
      user_id: "U1",
      game_pk: 100,
      play_index: 5,
      direction: "fire",
      action: "added",
      event_ts: "1700000000.000200",
      post_window: 0,
    });
  });

  test("post_window=true persists as 1", () => {
    insertVoteEvent(db, {
      userId: "U1",
      gamePk: 100,
      playIndex: 5,
      direction: "trash",
      action: "added",
      eventTs: "0",
      postWindow: true,
    });
    const row = db.prepare("SELECT post_window FROM votes").get() as {
      post_window: number;
    };
    expect(row.post_window).toBe(1);
  });
});

describe("computePlayTally", () => {
  test("empty event log yields zero counts", () => {
    const tally = computePlayTally(db, 1, 1);
    expect(tally).toEqual({ fire: 0, trash: 0, voters: new Set() });
  });

  test("single fire from one user", () => {
    vote("U1", "fire", "added");
    const tally = computePlayTally(db, 1, 1);
    expect(tally.fire).toBe(1);
    expect(tally.trash).toBe(0);
    expect(tally.voters.size).toBe(1);
  });

  test("add then remove same reaction yields zero", () => {
    vote("U1", "fire", "added");
    vote("U1", "fire", "removed");
    const tally = computePlayTally(db, 1, 1);
    expect(tally.fire).toBe(0);
    expect(tally.voters.size).toBe(0);
  });

  test("add, remove, add still counts as one", () => {
    vote("U1", "fire", "added");
    vote("U1", "fire", "removed");
    vote("U1", "fire", "added");
    const tally = computePlayTally(db, 1, 1);
    expect(tally.fire).toBe(1);
  });

  test("two distinct users firing yields fire=2 and voter_count=2", () => {
    vote("U1", "fire", "added");
    vote("U2", "fire", "added");
    const tally = computePlayTally(db, 1, 1);
    expect(tally.fire).toBe(2);
    expect(tally.voters.size).toBe(2);
  });

  test("a user firing AND trashing the same play counts in both buckets", () => {
    vote("U1", "fire", "added");
    vote("U1", "trash", "added");
    const tally = computePlayTally(db, 1, 1);
    expect(tally.fire).toBe(1);
    expect(tally.trash).toBe(1);
    expect(tally.voters.size).toBe(1);
  });

  test("late events (post_window=1) are excluded by default", () => {
    vote("U1", "fire", "added");
    vote("U2", "fire", "added", true); // arrived after the snapshot window
    const windowed = computePlayTally(db, 1, 1, true);
    expect(windowed.fire).toBe(1);
    const all = computePlayTally(db, 1, 1, false);
    expect(all.fire).toBe(2);
  });

  test("doesn't bleed across plays", () => {
    vote("U1", "fire", "added");
    insertVoteEvent(db, {
      userId: "U2",
      gamePk: 1,
      playIndex: 99,
      direction: "fire",
      action: "added",
      eventTs: "0",
      postWindow: false,
    });
    expect(computePlayTally(db, 1, 1).fire).toBe(1);
    expect(computePlayTally(db, 1, 99).fire).toBe(1);
  });
});

describe("isPostWindow", () => {
  test("returns false when no slack_play_messages row exists", () => {
    expect(isPostWindow(db, 1, 1)).toBe(false);
  });

  test("returns false for a freshly recorded play", () => {
    recordPlayMessage(db, 1, 1, "C1", "ts.play", "ts.parent");
    expect(isPostWindow(db, 1, 1)).toBe(false);
  });

  test("returns true for a play recorded more than 24 hours ago", () => {
    db.prepare(`
      INSERT INTO slack_play_messages (game_pk, play_index, channel, ts, parent_ts, posted_at, last_updated_at)
      VALUES (1, 1, 'C1', 'ts', 'parent', datetime('now', '-25 hours'), NULL);
    `).run();
    expect(isPostWindow(db, 1, 1)).toBe(true);
  });

  test("returns false for a play recorded just under 24 hours ago", () => {
    db.prepare(`
      INSERT INTO slack_play_messages (game_pk, play_index, channel, ts, parent_ts, posted_at, last_updated_at)
      VALUES (1, 1, 'C1', 'ts', 'parent', datetime('now', '-23 hours'), NULL);
    `).run();
    expect(isPostWindow(db, 1, 1)).toBe(false);
  });
});
