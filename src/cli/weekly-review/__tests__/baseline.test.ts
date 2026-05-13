import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../../storage/db";
import { computeBaseline, renderBaselineForSlack } from "../baseline";
import type { DetectedPlay } from "../../../types/play";

let db: Database;

const WINDOW = { weekStarting: "2026-04-26", weekEnding: "2026-05-02" };

function makePlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 100,
    playIndex: 1,
    date: "2026-04-28",
    fielderId: 7,
    fielderName: "Mookie Betts",
    fielderPosition: "RF",
    runnerId: 1,
    runnerName: "Some Runner",
    targetBase: "Home",
    batterName: "Some Batter",
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
    isOverturned: false,
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

function insertSnapshot(
  gamePk: number,
  playIndex: number,
  fire: number,
  trash: number,
  flagged = 0,
): void {
  db.prepare(
    `INSERT INTO vote_snapshots (game_pk, play_index, fire_count, trash_count, net_score, voter_count, snapshotted_at, tier_review_flagged)
     VALUES ($g, $p, $f, $t, $n, $v, datetime('now'), $flag);`,
  ).run({
    $g: gamePk,
    $p: playIndex,
    $f: fire,
    $t: trash,
    $n: fire - trash,
    $v: fire + trash,
    $flag: flagged,
  });
}

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("computeBaseline", () => {
  test("empty week returns zeros and empty arrays", () => {
    const b = computeBaseline(db, WINDOW);
    expect(b.totalPlays).toBe(0);
    expect(b.playsWithVotes).toBe(0);
    expect(b.flaggedCount).toBe(0);
    expect(b.topPositive).toEqual([]);
    expect(b.topNegative).toEqual([]);
    expect(b.byTier).toEqual([]);
    expect(b.byPositionRunners).toEqual([]);
  });

  test("aggregates plays + snapshots inside the window", () => {
    insertPlay(
      db,
      makePlay({
        playIndex: 1,
        date: "2026-04-28",
        tier: "high",
        runnersOn: "1st",
      }),
    );
    insertPlay(
      db,
      makePlay({
        playIndex: 2,
        date: "2026-04-29",
        tier: "high",
        runnersOn: "1st",
      }),
    );
    insertPlay(
      db,
      makePlay({ playIndex: 3, date: "2026-05-01", tier: "low" }),
    );
    // Outside window — must NOT appear
    insertPlay(
      db,
      makePlay({ playIndex: 4, date: "2026-04-25", tier: "high" }),
    );

    insertSnapshot(100, 1, 3, 0, 0);
    insertSnapshot(100, 2, 1, 4, 1); // flagged
    insertSnapshot(100, 3, 0, 0, 0);
    insertSnapshot(100, 4, 5, 0, 0); // outside-window snapshot

    const b = computeBaseline(db, WINDOW);
    expect(b.totalPlays).toBe(3);
    expect(b.playsWithVotes).toBe(2);
    expect(b.flaggedCount).toBe(1);

    expect(b.topPositive).toHaveLength(1);
    expect(b.topPositive[0]?.netScore).toBe(3);
    expect(b.topNegative).toHaveLength(1);
    expect(b.topNegative[0]?.netScore).toBe(-3);

    const high = b.byTier.find((t) => t.tier === "high");
    expect(high?.fireTotal).toBe(4);
    expect(high?.trashTotal).toBe(4);

    const rfWithRunner = b.byPositionRunners.find(
      (r) => r.position === "RF" && r.runnersOn === "1st",
    );
    expect(rfWithRunner?.fire).toBe(4);
    expect(rfWithRunner?.trash).toBe(4);
  });
});

describe("renderBaselineForSlack", () => {
  test("renders a single header line for an empty baseline", () => {
    const text = renderBaselineForSlack(computeBaseline(db, WINDOW));
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("0 plays");
  });

  test("includes by-tier and top-line summaries when populated", () => {
    insertPlay(db, makePlay({ playIndex: 1, date: "2026-04-28", tier: "high" }));
    insertSnapshot(100, 1, 4, 1, 0);

    const text = renderBaselineForSlack(computeBaseline(db, WINDOW));
    expect(text).toContain("By tier");
    expect(text).toContain("Top positive");
  });
});
