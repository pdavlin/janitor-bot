/**
 * Tests for the slack-finding-messages persistence helpers.
 *
 * Uses in-memory SQLite via createDatabase(":memory:") so the actual schema
 * is exercised rather than mocking the bun:sqlite API.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../storage/db";
import {
  recordFindingMessage,
  lookupFindingMessage,
  lookupFindingMessageByTs,
} from "../slack-finding-messages-store";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("recordFindingMessage / lookupFindingMessage", () => {
  test("inserts a new row keyed on (run_id, finding_id)", () => {
    recordFindingMessage(db, 42, 7, "C1", "1700000001.000100", "1700000000.000100");
    const ref = lookupFindingMessage(db, 42, 7);
    expect(ref).toEqual({
      channel: "C1",
      ts: "1700000001.000100",
      parentTs: "1700000000.000100",
      runId: 42,
      findingId: 7,
    });
  });

  test("returns null when no row exists", () => {
    expect(lookupFindingMessage(db, 999, 0)).toBeNull();
  });

  test("upsert overwrites ts and parent_ts on duplicate (run_id, finding_id)", () => {
    recordFindingMessage(db, 42, 7, "C1", "ts.old", "parent.old");
    recordFindingMessage(db, 42, 7, "C1", "ts.new", "parent.new");
    const ref = lookupFindingMessage(db, 42, 7);
    expect(ref).toEqual({
      channel: "C1",
      ts: "ts.new",
      parentTs: "parent.new",
      runId: 42,
      findingId: 7,
    });
  });

  test("different findings under the same run coexist", () => {
    recordFindingMessage(db, 42, 1, "C1", "ts.1", "parent");
    recordFindingMessage(db, 42, 2, "C1", "ts.2", "parent");
    expect(lookupFindingMessage(db, 42, 1)?.ts).toBe("ts.1");
    expect(lookupFindingMessage(db, 42, 2)?.ts).toBe("ts.2");
  });
});

describe("lookupFindingMessageByTs", () => {
  test("round-trip returns (runId, findingId) for a recorded reply", () => {
    recordFindingMessage(db, 42, 7, "C1", "ts.find", "ts.parent");
    const found = lookupFindingMessageByTs(db, "C1", "ts.find");
    expect(found).toEqual({ runId: 42, findingId: 7 });
  });

  test("returns null for an unknown ts", () => {
    expect(lookupFindingMessageByTs(db, "C1", "no.such.ts")).toBeNull();
  });

  test("matches on (channel, ts) — wrong channel returns null", () => {
    recordFindingMessage(db, 42, 7, "C1", "ts.find", "ts.parent");
    expect(lookupFindingMessageByTs(db, "C2", "ts.find")).toBeNull();
  });
});
