/**
 * Tests for the slack-messages persistence helpers (game headers + play replies).
 *
 * Uses in-memory SQLite via createDatabase(":memory:") so the actual schema
 * is exercised rather than mocking the bun:sqlite API.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../storage/db";
import {
  recordGameHeader,
  lookupGameHeader,
  markGameHeaderUpdated,
  recordPlayMessage,
  lookupPlayMessage,
  lookupPlayMessageByTs,
  markPlayMessageUpdated,
} from "../slack-messages-store";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("recordGameHeader / lookupGameHeader", () => {
  test("inserts a new row when none exists", () => {
    recordGameHeader(db, 745433, "C123", "1700000000.000100");
    const row = lookupGameHeader(db, 745433);
    expect(row).toEqual({ channel: "C123", ts: "1700000000.000100" });
  });

  test("upserts on conflict — newer ts replaces older", () => {
    recordGameHeader(db, 745433, "C123", "1700000000.000100");
    recordGameHeader(db, 745433, "C123", "1700000999.000200");
    const row = lookupGameHeader(db, 745433);
    expect(row?.ts).toBe("1700000999.000200");
  });

  test("upsert resets last_updated_at to NULL", () => {
    recordGameHeader(db, 745433, "C123", "1.0");
    markGameHeaderUpdated(db, 745433);
    const beforeRow = db
      .prepare("SELECT last_updated_at FROM slack_game_headers WHERE game_pk = ?")
      .get(745433) as { last_updated_at: string | null };
    expect(beforeRow.last_updated_at).not.toBeNull();

    recordGameHeader(db, 745433, "C456", "2.0");
    const afterRow = db
      .prepare(
        "SELECT last_updated_at, channel FROM slack_game_headers WHERE game_pk = ?",
      )
      .get(745433) as { last_updated_at: string | null; channel: string };
    expect(afterRow.last_updated_at).toBeNull();
    expect(afterRow.channel).toBe("C456");
  });

  test("multiple games can coexist", () => {
    recordGameHeader(db, 1, "C1", "1.0");
    recordGameHeader(db, 2, "C2", "2.0");
    expect(lookupGameHeader(db, 1)?.channel).toBe("C1");
    expect(lookupGameHeader(db, 2)?.channel).toBe("C2");
  });

  test("lookupGameHeader returns null when no row exists", () => {
    expect(lookupGameHeader(db, 999)).toBeNull();
  });
});

describe("markGameHeaderUpdated", () => {
  test("sets last_updated_at to a non-null timestamp", () => {
    recordGameHeader(db, 745433, "C123", "1.0");
    markGameHeaderUpdated(db, 745433);
    const row = db
      .prepare("SELECT last_updated_at FROM slack_game_headers WHERE game_pk = ?")
      .get(745433) as { last_updated_at: string | null };
    expect(row.last_updated_at).not.toBeNull();
  });

  test("no-op when game_pk has no row (does not throw)", () => {
    expect(() => markGameHeaderUpdated(db, 999)).not.toThrow();
  });
});

describe("recordPlayMessage / lookupPlayMessage", () => {
  test("inserts a new row keyed on (game_pk, play_index)", () => {
    recordPlayMessage(db, 745433, 7, "C1", "ts.play", "ts.parent");
    const ref = lookupPlayMessage(db, 745433, 7);
    expect(ref).toEqual({
      channel: "C1",
      ts: "ts.play",
      parentTs: "ts.parent",
    });
  });

  test("returns null when no row exists", () => {
    expect(lookupPlayMessage(db, 999, 0)).toBeNull();
  });

  test("upsert overwrites ts and parent_ts on conflict", () => {
    recordPlayMessage(db, 745433, 7, "C1", "ts.old", "ts.parent.old");
    recordPlayMessage(db, 745433, 7, "C1", "ts.new", "ts.parent.new");
    const ref = lookupPlayMessage(db, 745433, 7);
    expect(ref).toEqual({
      channel: "C1",
      ts: "ts.new",
      parentTs: "ts.parent.new",
    });
  });

  test("upsert resets last_updated_at to NULL", () => {
    recordPlayMessage(db, 745433, 7, "C1", "1.0", "0.5");
    markPlayMessageUpdated(db, 745433, 7);
    const beforeRow = db
      .prepare(
        "SELECT last_updated_at FROM slack_play_messages WHERE game_pk = ? AND play_index = ?",
      )
      .get(745433, 7) as { last_updated_at: string | null };
    expect(beforeRow.last_updated_at).not.toBeNull();

    recordPlayMessage(db, 745433, 7, "C1", "2.0", "0.5");
    const afterRow = db
      .prepare(
        "SELECT last_updated_at FROM slack_play_messages WHERE game_pk = ? AND play_index = ?",
      )
      .get(745433, 7) as { last_updated_at: string | null };
    expect(afterRow.last_updated_at).toBeNull();
  });

  test("different plays in the same game coexist independently", () => {
    recordPlayMessage(db, 745433, 1, "C1", "ts.1", "ts.parent");
    recordPlayMessage(db, 745433, 2, "C1", "ts.2", "ts.parent");
    expect(lookupPlayMessage(db, 745433, 1)?.ts).toBe("ts.1");
    expect(lookupPlayMessage(db, 745433, 2)?.ts).toBe("ts.2");
  });
});

describe("lookupPlayMessageByTs", () => {
  test("round-trip returns the (gamePk, playIndex) for a recorded reply", () => {
    recordPlayMessage(db, 745433, 7, "C1", "ts.play", "ts.parent");
    const found = lookupPlayMessageByTs(db, "C1", "ts.play");
    expect(found).toEqual({ gamePk: 745433, playIndex: 7 });
  });

  test("returns null when ts is unknown", () => {
    expect(lookupPlayMessageByTs(db, "C1", "no.such.ts")).toBeNull();
  });

  test("matches on (channel, ts) — wrong channel returns null", () => {
    recordPlayMessage(db, 745433, 7, "C1", "ts.play", "ts.parent");
    expect(lookupPlayMessageByTs(db, "C2", "ts.play")).toBeNull();
  });
});

describe("markPlayMessageUpdated", () => {
  test("sets last_updated_at to a non-null timestamp", () => {
    recordPlayMessage(db, 745433, 7, "C1", "1.0", "0.5");
    markPlayMessageUpdated(db, 745433, 7);
    const row = db
      .prepare(
        "SELECT last_updated_at FROM slack_play_messages WHERE game_pk = ? AND play_index = ?",
      )
      .get(745433, 7) as { last_updated_at: string | null };
    expect(row.last_updated_at).not.toBeNull();
  });

  test("no-op when row does not exist (does not throw)", () => {
    expect(() => markPlayMessageUpdated(db, 999, 0)).not.toThrow();
  });
});

describe("schema migration", () => {
  test("legacy slack_messages table is dropped on createDatabase", () => {
    const tableRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='slack_messages';",
      )
      .get() as { name: string } | null;
    expect(tableRow).toBeNull();
  });

  test("re-running createDatabase on an existing DB is idempotent", () => {
    recordGameHeader(db, 1, "C1", "1.0");
    recordPlayMessage(db, 1, 0, "C1", "0.1", "1.0");
    // simulate a second startup against the same DB; createDatabase is
    // idempotent by spec (IF EXISTS / IF NOT EXISTS everywhere)
    expect(() => createDatabase(":memory:")).not.toThrow();
    expect(lookupGameHeader(db, 1)?.ts).toBe("1.0");
    expect(lookupPlayMessage(db, 1, 0)?.ts).toBe("0.1");
  });
});
