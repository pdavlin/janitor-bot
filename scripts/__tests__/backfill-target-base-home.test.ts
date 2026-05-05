import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../src/storage/db";
import {
  findAffectedRows,
  recomputeTiers,
  applyMigration,
  summarize,
} from "../backfill-target-base-home";
import type { DetectedPlay } from "../../src/types/play";

let db: Database;

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
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("backfill-target-base-home", () => {
  test("findAffectedRows returns only rows with target_base='4B'", () => {
    insertPlay(db, makePlay({ playIndex: 1, targetBase: "Home" }));
    insertPlay(db, makePlay({ playIndex: 2, runnerId: 2, targetBase: "4B", tier: "medium" }));
    insertPlay(db, makePlay({ playIndex: 3, runnerId: 3, targetBase: "3B", tier: "medium" }));

    const rows = findAffectedRows(db);
    expect(rows.map((r) => r.play_index)).toEqual([2]);
  });

  test("recomputeTiers upgrades a direct LF -> C 4B play to high (4 + 2 = 6)", () => {
    const row = {
      id: 1,
      game_pk: 100,
      play_index: 1,
      credit_chain: "LF -> C",
      video_url: null,
      tier: "medium" as const,
    };
    const [recomputed] = recomputeTiers([row]);
    expect(recomputed!.oldTier).toBe("medium");
    expect(recomputed!.newTier).toBe("high");
    expect(recomputed!.changed).toBe(true);
  });

  test("recomputeTiers keeps a relay 4B (3-segment chain) at medium (4 + 0 = 4)", () => {
    const row = {
      id: 1,
      game_pk: 100,
      play_index: 1,
      credit_chain: "LF -> SS -> C",
      video_url: null,
      tier: "low" as const,
    };
    const [recomputed] = recomputeTiers([row]);
    // 4 (Home) + 0 (relay, not direct) + 0 (no video) = 4 -> medium
    expect(recomputed!.newTier).toBe("medium");
    expect(recomputed!.changed).toBe(true);
  });

  test("recomputeTiers includes the +1 video bonus when video_url is present", () => {
    const row = {
      id: 1,
      game_pk: 100,
      play_index: 1,
      credit_chain: "LF -> SS -> C",
      video_url: "https://savant.example/clip.mp4",
      tier: "low" as const,
    };
    const [recomputed] = recomputeTiers([row]);
    // 4 (Home) + 0 (relay) + 1 (video) = 5 -> high
    expect(recomputed!.newTier).toBe("high");
  });

  test("applyMigration writes target_base='Home' and the recomputed tier", () => {
    insertPlay(
      db,
      makePlay({
        playIndex: 1,
        targetBase: "4B",
        creditChain: "LF -> C",
        tier: "medium",
      }),
    );
    const affected = findAffectedRows(db);
    const recomputed = recomputeTiers(affected);
    applyMigration(db, recomputed);

    const row = db
      .prepare(`SELECT target_base, tier FROM plays WHERE play_index = 1;`)
      .get() as { target_base: string; tier: string };
    expect(row.target_base).toBe("Home");
    expect(row.tier).toBe("high");
  });

  test("applyMigration is idempotent", () => {
    insertPlay(
      db,
      makePlay({
        playIndex: 1,
        targetBase: "4B",
        creditChain: "LF -> C",
        tier: "medium",
      }),
    );
    const first = findAffectedRows(db);
    applyMigration(db, recomputeTiers(first));

    const second = findAffectedRows(db);
    expect(second).toHaveLength(0);
  });

  test("summarize returns counts grouped by tier transition", () => {
    const recomputed = [
      { id: 1, game_pk: 100, play_index: 1, oldTier: "medium" as const, newTier: "high" as const, changed: true },
      { id: 2, game_pk: 100, play_index: 2, oldTier: "medium" as const, newTier: "high" as const, changed: true },
      { id: 3, game_pk: 100, play_index: 3, oldTier: "low" as const, newTier: "medium" as const, changed: true },
    ];
    const s = summarize(recomputed);
    expect(s.total).toBe(3);
    expect(s.retiered).toBe(3);
    expect(s.byTransition).toEqual({ "medium -> high": 2, "low -> medium": 1 });
  });
});
