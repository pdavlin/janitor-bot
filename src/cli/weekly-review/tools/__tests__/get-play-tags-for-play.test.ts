import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../../../storage/db";
import { getPlayTagsForPlay } from "../get-play-tags-for-play";
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
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

function getInsertedPlayId(): number {
  return (db.prepare("SELECT id FROM plays ORDER BY id DESC LIMIT 1;").get() as { id: number }).id;
}

function insertTag(opts: {
  gamePk: number;
  playIndex: number | null;
  tagType: "tier_dispute" | "video_issue";
  tagValue: string;
  matchedText: string;
}): void {
  db.prepare(
    `INSERT INTO play_tags (game_pk, play_index, tag_type, tag_value, comment_ts, comment_user_id, matched_text, received_at)
     VALUES ($g, $p, $type, $value, '1.001', 'U1', $matched, datetime('now'));`,
  ).run({
    $g: opts.gamePk,
    $p: opts.playIndex,
    $type: opts.tagType,
    $value: opts.tagValue,
    $matched: opts.matchedText,
  });
}

describe("getPlayTagsForPlay", () => {
  test("returns only tagType and tagValue (no matched_text)", () => {
    insertPlay(db, makePlay());
    const playId = getInsertedPlayId();
    insertTag({
      gamePk: 100,
      playIndex: 1,
      tagType: "tier_dispute",
      tagValue: "should_be_high",
      matchedText: "this should be a 5/5 high",
    });

    const result = getPlayTagsForPlay(db, playId);
    if ("error" in result) throw new Error("expected play to exist");
    expect(result.playId).toBe(playId);
    expect(result.tags).toEqual([{ tagType: "tier_dispute", tagValue: "should_be_high" }]);
    for (const tag of result.tags) {
      expect(tag).not.toHaveProperty("matchedText");
      expect(tag).not.toHaveProperty("matched_text");
      expect(tag).not.toHaveProperty("text");
      expect(tag).not.toHaveProperty("message");
      expect(tag).not.toHaveProperty("transcript");
    }
  });

  test("includes game-level tags (play_index NULL) for the play's game", () => {
    insertPlay(db, makePlay());
    const playId = getInsertedPlayId();
    insertTag({
      gamePk: 100,
      playIndex: null,
      tagType: "video_issue",
      tagValue: "missing_video",
      matchedText: "no video for this game",
    });

    const result = getPlayTagsForPlay(db, playId);
    if ("error" in result) throw new Error("expected play");
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0]?.tagType).toBe("video_issue");
  });

  test("returns empty tags when none exist for the play", () => {
    insertPlay(db, makePlay());
    const playId = getInsertedPlayId();
    const result = getPlayTagsForPlay(db, playId);
    if ("error" in result) throw new Error("expected play");
    expect(result.tags).toEqual([]);
  });

  test("excludes tags from other games", () => {
    insertPlay(db, makePlay());
    const playId = getInsertedPlayId();
    insertTag({
      gamePk: 999,
      playIndex: 1,
      tagType: "tier_dispute",
      tagValue: "should_be_high",
      matchedText: "x",
    });
    const result = getPlayTagsForPlay(db, playId);
    if ("error" in result) throw new Error("expected play");
    expect(result.tags).toEqual([]);
  });

  test("returns not_found for unknown play id", () => {
    expect(getPlayTagsForPlay(db, 9999)).toEqual({ error: "not_found" });
  });
});
