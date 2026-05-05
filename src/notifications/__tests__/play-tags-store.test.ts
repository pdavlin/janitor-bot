/**
 * Tests for the play-tags persistence helpers. Uses in-memory SQLite so the
 * actual schema is exercised.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../storage/db";
import { insertPlayTag, queryPlayTags } from "../play-tags-store";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("insertPlayTag / queryPlayTags", () => {
  test("inserts a play-scoped tag and reads it back", () => {
    insertPlayTag(db, {
      gamePk: 7000,
      playIndex: 3,
      tagType: "tier_dispute",
      tagValue: "should_be_high",
      commentTs: "100.001",
      commentUserId: "U123",
      matchedText: "should be high",
    });

    const rows = queryPlayTags(db, 7000, 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gamePk: 7000,
      playIndex: 3,
      tagType: "tier_dispute",
      tagValue: "should_be_high",
      commentTs: "100.001",
      commentUserId: "U123",
      matchedText: "should be high",
    });
    expect(rows[0].id).toBeGreaterThan(0);
    expect(typeof rows[0].receivedAt).toBe("string");
  });

  test("inserts a game-scoped tag (play_index NULL)", () => {
    insertPlayTag(db, {
      gamePk: 7000,
      playIndex: null,
      tagType: "video_issue",
      tagValue: "wrong_video",
      commentTs: "100.002",
      commentUserId: "U999",
      matchedText: "wrong video",
    });

    const rows = queryPlayTags(db, 7000, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].playIndex).toBeNull();
    expect(rows[0].tagValue).toBe("wrong_video");
  });

  test("queryPlayTags isolates by playIndex", () => {
    insertPlayTag(db, {
      gamePk: 7000,
      playIndex: 1,
      tagType: "tier_dispute",
      tagValue: "should_be_high",
      commentTs: "100.001",
      commentUserId: "U1",
      matchedText: "should be high",
    });
    insertPlayTag(db, {
      gamePk: 7000,
      playIndex: 2,
      tagType: "tier_dispute",
      tagValue: "should_be_low",
      commentTs: "100.002",
      commentUserId: "U2",
      matchedText: "should be low",
    });

    expect(queryPlayTags(db, 7000, 1)).toHaveLength(1);
    expect(queryPlayTags(db, 7000, 2)).toHaveLength(1);
    expect(queryPlayTags(db, 7000, 3)).toHaveLength(0);
  });

  test("rejects an invalid tag_type via CHECK constraint", () => {
    expect(() =>
      db.prepare(`
        INSERT INTO play_tags (
          game_pk, play_index, tag_type, tag_value,
          comment_ts, comment_user_id, matched_text
        ) VALUES (1, 1, 'bogus', 'x', '0.0', 'U', 'x');
      `).run(),
    ).toThrow();
  });

  test("multiple inserts with identical args produce multiple rows", () => {
    const args = {
      gamePk: 7000,
      playIndex: 3,
      tagType: "tier_dispute" as const,
      tagValue: "should_be_high",
      commentTs: "100.001",
      commentUserId: "U123",
      matchedText: "should be high",
    };
    insertPlayTag(db, args);
    insertPlayTag(db, args);
    expect(queryPlayTags(db, 7000, 3)).toHaveLength(2);
  });
});
