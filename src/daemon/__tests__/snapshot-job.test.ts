/**
 * Tests for the vote snapshot job.
 *
 * Each test sets up a play row, a slack_play_messages row (with `posted_at`
 * pegged into the past so the window logic triggers), and a few vote events,
 * then runs `runSnapshotCycle` and asserts on the resulting snapshot row.
 */

import { test, expect, describe, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../storage/db";
import { recordPlayMessage } from "../../notifications/slack-messages-store";
import { insertVoteEvent } from "../../notifications/slack-votes-store";
import { runSnapshotCycle } from "../snapshot-job";
import type { DetectedPlay, Tier } from "../../types/play";
import type { Logger } from "../../logger";

let db: Database;

function silentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

function makePlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 1,
    playIndex: 1,
    date: "2026-04-01",
    fielderId: 1,
    fielderName: "Test Fielder",
    fielderPosition: "CF",
    runnerId: 2,
    runnerName: "Test Runner",
    targetBase: "3B",
    batterName: "Test Batter",
    inning: 1,
    halfInning: "top",
    awayScore: 0,
    homeScore: 0,
    awayTeam: "AAA",
    homeTeam: "BBB",
    description: "Test play",
    creditChain: "CF -> 3B",
    tier: "high",
    outs: 0,
    runnersOn: "",
    isOverturned: false,
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

/** Inserts a play with the given tier and a slack_play_messages row backdated by `hoursAgo`. */
function seedPlay(
  gamePk: number,
  playIndex: number,
  tier: Tier,
  hoursAgo: number,
): void {
  insertPlay(db, makePlay({ gamePk, playIndex, tier }));
  db.prepare(`
    INSERT INTO slack_play_messages (game_pk, play_index, channel, ts, parent_ts, posted_at, last_updated_at)
    VALUES ($gamePk, $playIndex, 'C1', $ts, '0.0', datetime('now', $hours), NULL);
  `).run({
    $gamePk: gamePk,
    $playIndex: playIndex,
    $ts: `ts.${gamePk}.${playIndex}`,
    $hours: `-${hoursAgo} hours`,
  });
}

function castVote(
  gamePk: number,
  playIndex: number,
  userId: string,
  direction: "fire" | "trash",
): void {
  insertVoteEvent(db, {
    userId,
    gamePk,
    playIndex,
    direction,
    action: "added",
    eventTs: "0",
    postWindow: false,
  });
}

function getSnapshot(
  gamePk: number,
  playIndex: number,
):
  | {
      fire_count: number;
      trash_count: number;
      net_score: number;
      voter_count: number;
      tier_review_flagged: number;
      tier_review_reason: string | null;
    }
  | null {
  return db
    .prepare(
      `SELECT fire_count, trash_count, net_score, voter_count, tier_review_flagged, tier_review_reason
       FROM vote_snapshots WHERE game_pk = $gamePk AND play_index = $playIndex;`,
    )
    .get({ $gamePk: gamePk, $playIndex: playIndex }) as
    | {
        fire_count: number;
        trash_count: number;
        net_score: number;
        voter_count: number;
        tier_review_flagged: number;
        tier_review_reason: string | null;
      }
    | null;
}

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("runSnapshotCycle: window selection", () => {
  test("does not snapshot plays whose 24h window has not elapsed", () => {
    seedPlay(1, 1, "high", 23);
    castVote(1, 1, "U1", "fire");

    runSnapshotCycle(db, silentLogger());

    expect(getSnapshot(1, 1)).toBeNull();
  });

  test("snapshots plays past the 24h window", () => {
    seedPlay(1, 1, "high", 25);
    castVote(1, 1, "U1", "fire");
    castVote(1, 1, "U2", "fire");

    runSnapshotCycle(db, silentLogger());

    const snap = getSnapshot(1, 1);
    expect(snap).not.toBeNull();
    expect(snap!.fire_count).toBe(2);
    expect(snap!.trash_count).toBe(0);
    expect(snap!.net_score).toBe(2);
    expect(snap!.voter_count).toBe(2);
  });

  test("does not snapshot plays without any slack_play_messages row", () => {
    insertPlay(db, makePlay({ gamePk: 1, playIndex: 1, tier: "high" }));
    castVote(1, 1, "U1", "fire");

    runSnapshotCycle(db, silentLogger());

    expect(getSnapshot(1, 1)).toBeNull();
  });
});

describe("runSnapshotCycle: tier review flag", () => {
  test("flags high-tier play with 2+ trash votes (channel disagrees down)", () => {
    seedPlay(1, 1, "high", 25);
    castVote(1, 1, "U1", "trash");
    castVote(1, 1, "U2", "trash");

    runSnapshotCycle(db, silentLogger());

    const snap = getSnapshot(1, 1);
    expect(snap!.tier_review_flagged).toBe(1);
    expect(snap!.tier_review_reason).toBe("channel_disagrees_high_or_medium");
  });

  test("flags medium-tier play with 2+ trash votes", () => {
    seedPlay(1, 1, "medium", 25);
    castVote(1, 1, "U1", "trash");
    castVote(1, 1, "U2", "trash");

    runSnapshotCycle(db, silentLogger());

    expect(getSnapshot(1, 1)!.tier_review_flagged).toBe(1);
  });

  test("flags low-tier play with 2+ fire votes (channel disagrees up)", () => {
    seedPlay(1, 1, "low", 25);
    castVote(1, 1, "U1", "fire");
    castVote(1, 1, "U2", "fire");

    runSnapshotCycle(db, silentLogger());

    const snap = getSnapshot(1, 1);
    expect(snap!.tier_review_flagged).toBe(1);
    expect(snap!.tier_review_reason).toBe("channel_disagrees_low");
  });

  test("does not flag high-tier play with only one trash vote", () => {
    seedPlay(1, 1, "high", 25);
    castVote(1, 1, "U1", "trash");

    runSnapshotCycle(db, silentLogger());

    const snap = getSnapshot(1, 1);
    expect(snap!.tier_review_flagged).toBe(0);
    expect(snap!.tier_review_reason).toBeNull();
  });

  test("does not flag low-tier play that the channel agreed with (zero fires)", () => {
    seedPlay(1, 1, "low", 25);
    castVote(1, 1, "U1", "trash");

    runSnapshotCycle(db, silentLogger());

    expect(getSnapshot(1, 1)!.tier_review_flagged).toBe(0);
  });

  test("does not flag low-tier play with only one fire vote", () => {
    seedPlay(1, 1, "low", 25);
    castVote(1, 1, "U1", "fire");

    runSnapshotCycle(db, silentLogger());

    expect(getSnapshot(1, 1)!.tier_review_flagged).toBe(0);
  });
});

describe("runSnapshotCycle: idempotency", () => {
  test("running twice leaves a single snapshot row", () => {
    seedPlay(1, 1, "high", 25);
    castVote(1, 1, "U1", "fire");

    runSnapshotCycle(db, silentLogger());
    const firstSnap = getSnapshot(1, 1);

    castVote(1, 1, "U2", "fire"); // would change tally if re-snapshotted
    runSnapshotCycle(db, silentLogger());

    const secondSnap = getSnapshot(1, 1);
    expect(secondSnap).toEqual(firstSnap);
  });

  test("running with no due plays writes nothing", () => {
    seedPlay(1, 1, "high", 1);
    castVote(1, 1, "U1", "fire");

    runSnapshotCycle(db, silentLogger());

    const count = (
      db
        .prepare("SELECT COUNT(*) as c FROM vote_snapshots")
        .get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});

describe("runSnapshotCycle: missing play row", () => {
  test("logs warn and does not write a snapshot when the play row is missing", () => {
    db.prepare(`
      INSERT INTO slack_play_messages (game_pk, play_index, channel, ts, parent_ts, posted_at, last_updated_at)
      VALUES (1, 1, 'C1', 'ts', '0', datetime('now', '-25 hours'), NULL);
    `).run();
    castVote(1, 1, "U1", "fire");
    const logger = silentLogger();

    runSnapshotCycle(db, logger);

    expect(getSnapshot(1, 1)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
