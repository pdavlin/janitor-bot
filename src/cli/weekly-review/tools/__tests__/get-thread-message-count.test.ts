import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../../../storage/db";
import { recordPlayMessage } from "../../../../notifications/slack-messages-store";
import { getThreadMessageCount } from "../get-thread-message-count";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("getThreadMessageCount", () => {
  test("counts recorded play replies for a game", () => {
    for (let i = 1; i <= 4; i++) {
      recordPlayMessage(db, 100, i, "C123", `1.${i}`, "1.000");
    }
    const result = getThreadMessageCount(db, 100);
    expect(result).toEqual({ gamePk: 100, messageCount: 4 });
  });

  test("returns zero when no rows exist for the game", () => {
    expect(getThreadMessageCount(db, 999)).toEqual({
      gamePk: 999,
      messageCount: 0,
    });
  });

  test("does not include any text or matched_text fields", () => {
    recordPlayMessage(db, 100, 1, "C123", "1.001", "1.000");
    const result = getThreadMessageCount(db, 100);
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("message");
    expect(result).not.toHaveProperty("messages");
    expect(result).not.toHaveProperty("transcript");
    expect(result).not.toHaveProperty("matched_text");
  });
});
