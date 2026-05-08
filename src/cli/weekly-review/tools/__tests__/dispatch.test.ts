import { test, expect, describe, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../../../storage/db";
import { createLogger } from "../../../../logger";
import { dispatchToolCall, type ToolContext } from "../dispatch";
import type { DetectedPlay } from "../../../../types/play";

let db: Database;
let ctx: ToolContext;

beforeEach(() => {
  db = createDatabase(":memory:");
  ctx = { db, logger: createLogger("error") };
});

function makePlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 100,
    playIndex: 1,
    date: "2026-04-28",
    fielderId: 7,
    fielderName: "M",
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
    description: "x",
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

describe("dispatchToolCall", () => {
  test("routes getVoteSnapshot to its implementation", () => {
    insertPlay(db, makePlay());
    const playId = (db.prepare("SELECT id FROM plays LIMIT 1;").get() as { id: number }).id;

    const result = dispatchToolCall("getVoteSnapshot", { playId }, ctx);
    expect(result).toMatchObject({ playId, gamePk: 100, fireCount: 0 });
  });

  test("routes getPlayDetails to its implementation", () => {
    insertPlay(db, makePlay());
    const playId = (db.prepare("SELECT id FROM plays LIMIT 1;").get() as { id: number }).id;

    const result = dispatchToolCall("getPlayDetails", { playId }, ctx);
    expect(result).toMatchObject({ playId, position: "RF", targetBase: "Home" });
  });

  test("routes getThreadMessageCount", () => {
    const result = dispatchToolCall("getThreadMessageCount", { gamePk: 100 }, ctx);
    expect(result).toEqual({ gamePk: 100, messageCount: 0 });
  });

  test("routes getHistoricalFindingOutcomes", () => {
    const result = dispatchToolCall(
      "getHistoricalFindingOutcomes",
      { suspectedRuleArea: "ranking.ts:target_base_scores", weeks: 8 },
      ctx,
    );
    expect(result).toMatchObject({
      ruleArea: "ranking.ts:target_base_scores",
      weeks: 8,
      confirmed: 0,
    });
  });

  test("routes getPriorFindingDescription", () => {
    const result = dispatchToolCall(
      "getPriorFindingDescription",
      { findingId: 9999 },
      ctx,
    );
    expect(result).toEqual({ error: "not_found" });
  });

  test("routes queryPlaysInWindow", () => {
    insertPlay(db, makePlay({ date: "2026-04-28" }));
    const result = dispatchToolCall(
      "queryPlaysInWindow",
      { weekStarting: "2026-04-26", weekEnding: "2026-05-02" },
      ctx,
    );
    expect(result).toMatchObject({ count: 1 });
  });

  test("routes getPlayTagsForPlay", () => {
    insertPlay(db, makePlay());
    const playId = (db.prepare("SELECT id FROM plays LIMIT 1;").get() as { id: number }).id;
    const result = dispatchToolCall("getPlayTagsForPlay", { playId }, ctx);
    expect(result).toMatchObject({ playId, tags: [] });
  });

  test("returns unknown_tool for unrecognized name", () => {
    const result = dispatchToolCall("doesNotExist", {}, ctx);
    expect(result).toEqual({ error: "unknown_tool", message: "doesNotExist" });
  });

  test("returns bad_input when required args are missing or wrong type", () => {
    const result = dispatchToolCall("getVoteSnapshot", { playId: "not-a-number" }, ctx);
    expect(result).toMatchObject({ error: "bad_input" });
  });

  test("converts a thrown error into internal_error", () => {
    const brokenDb = { prepare: () => { throw new Error("boom"); } } as unknown as Database;
    const warnSpy = mock(() => {});
    const brokenCtx: ToolContext = {
      db: brokenDb,
      logger: { ...createLogger("error"), warn: warnSpy },
    };
    const result = dispatchToolCall("getVoteSnapshot", { playId: 1 }, brokenCtx);
    expect(result).toMatchObject({ error: "internal_error" });
    expect(warnSpy).toHaveBeenCalled();
  });
});
