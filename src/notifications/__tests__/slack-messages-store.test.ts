/**
 * Tests for the slack_messages persistence helpers.
 *
 * Uses in-memory SQLite via createDatabase(":memory:") to exercise the
 * actual schema rather than mocking the bun:sqlite API.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../storage/db";
import {
  recordSlackMessage,
  lookupSlackMessage,
  markSlackMessageUpdated,
} from "../slack-messages-store";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("recordSlackMessage", () => {
  test("inserts a new row when none exists", () => {
    recordSlackMessage(db, 745433, "C123", "1700000000.000100");
    const row = lookupSlackMessage(db, 745433);
    expect(row).toEqual({ channel: "C123", ts: "1700000000.000100" });
  });

  test("upserts on conflict — newer ts replaces older", () => {
    recordSlackMessage(db, 745433, "C123", "1700000000.000100");
    recordSlackMessage(db, 745433, "C123", "1700000999.000200");
    const row = lookupSlackMessage(db, 745433);
    expect(row?.ts).toBe("1700000999.000200");
  });

  test("upsert resets last_updated_at to NULL", () => {
    recordSlackMessage(db, 745433, "C123", "1.0");
    markSlackMessageUpdated(db, 745433);
    const beforeRow = db
      .prepare("SELECT last_updated_at FROM slack_messages WHERE game_pk = ?")
      .get(745433) as { last_updated_at: string | null };
    expect(beforeRow.last_updated_at).not.toBeNull();

    recordSlackMessage(db, 745433, "C456", "2.0");
    const afterRow = db
      .prepare("SELECT last_updated_at, channel FROM slack_messages WHERE game_pk = ?")
      .get(745433) as { last_updated_at: string | null; channel: string };
    expect(afterRow.last_updated_at).toBeNull();
    expect(afterRow.channel).toBe("C456");
  });

  test("multiple games can coexist", () => {
    recordSlackMessage(db, 1, "C1", "1.0");
    recordSlackMessage(db, 2, "C2", "2.0");
    expect(lookupSlackMessage(db, 1)?.channel).toBe("C1");
    expect(lookupSlackMessage(db, 2)?.channel).toBe("C2");
  });
});

describe("lookupSlackMessage", () => {
  test("returns null when no row exists", () => {
    expect(lookupSlackMessage(db, 999)).toBeNull();
  });
});

describe("markSlackMessageUpdated", () => {
  test("sets last_updated_at to a non-null timestamp", () => {
    recordSlackMessage(db, 745433, "C123", "1.0");
    markSlackMessageUpdated(db, 745433);
    const row = db
      .prepare("SELECT last_updated_at FROM slack_messages WHERE game_pk = ?")
      .get(745433) as { last_updated_at: string | null };
    expect(row.last_updated_at).not.toBeNull();
  });

  test("no-op when game_pk has no row (does not throw)", () => {
    expect(() => markSlackMessageUpdated(db, 999)).not.toThrow();
  });
});
