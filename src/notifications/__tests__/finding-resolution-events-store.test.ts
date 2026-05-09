/**
 * Tests for finding-resolution-events-store: insert + post-window semantics.
 * Uses an in-memory DB so the actual schema and constraints are exercised,
 * not mocked.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../storage/db";
import { recordFindingMessage } from "../slack-finding-messages-store";
import {
  insertFindingResolutionEvent,
  isFindingPostWindow,
  reactionToResolutionDirection,
} from "../finding-resolution-events-store";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("reactionToResolutionDirection", () => {
  test("maps :white_check_mark: to confirm", () => {
    expect(reactionToResolutionDirection("white_check_mark")).toBe("confirm");
  });

  test("maps :x: to reject", () => {
    expect(reactionToResolutionDirection("x")).toBe("reject");
  });

  test("returns null for unmapped reactions", () => {
    expect(reactionToResolutionDirection("fire")).toBeNull();
    expect(reactionToResolutionDirection("wastebasket")).toBeNull();
    expect(reactionToResolutionDirection("thumbsup")).toBeNull();
  });
});

describe("insertFindingResolutionEvent", () => {
  test("writes a row that reads back via raw SQL", () => {
    insertFindingResolutionEvent(db, {
      findingId: 11,
      userId: "U1",
      direction: "confirm",
      action: "added",
      eventTs: "1700000000.000200",
      postWindow: false,
    });
    const row = db.prepare("SELECT * FROM finding_resolution_events;").get() as {
      finding_id: number;
      user_id: string;
      direction: string;
      action: string;
      event_ts: string;
      post_window: number;
    };
    expect(row).toMatchObject({
      finding_id: 11,
      user_id: "U1",
      direction: "confirm",
      action: "added",
      event_ts: "1700000000.000200",
      post_window: 0,
    });
  });

  test("post_window=true persists as 1", () => {
    insertFindingResolutionEvent(db, {
      findingId: 11,
      userId: "U1",
      direction: "reject",
      action: "added",
      eventTs: "0",
      postWindow: true,
    });
    const row = db
      .prepare("SELECT post_window FROM finding_resolution_events;")
      .get() as { post_window: number };
    expect(row.post_window).toBe(1);
  });

  test("multiple events for the same (user, finding, direction) are allowed", () => {
    insertFindingResolutionEvent(db, {
      findingId: 11,
      userId: "U1",
      direction: "confirm",
      action: "added",
      eventTs: "1",
      postWindow: false,
    });
    insertFindingResolutionEvent(db, {
      findingId: 11,
      userId: "U1",
      direction: "confirm",
      action: "removed",
      eventTs: "2",
      postWindow: false,
    });
    insertFindingResolutionEvent(db, {
      findingId: 11,
      userId: "U1",
      direction: "confirm",
      action: "added",
      eventTs: "3",
      postWindow: false,
    });
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM finding_resolution_events;")
      .get() as { c: number };
    expect(count.c).toBe(3);
  });
});

describe("isFindingPostWindow", () => {
  test("returns false when no slack_finding_messages row exists", () => {
    expect(isFindingPostWindow(db, 11)).toBe(false);
  });

  test("returns false for a freshly recorded finding reply", () => {
    recordFindingMessage(db, 42, 11, "C1", "ts.find", "ts.parent");
    expect(isFindingPostWindow(db, 11)).toBe(false);
  });

  test("returns true for a finding reply recorded more than 24 hours ago", () => {
    db.prepare(`
      INSERT INTO slack_finding_messages
        (run_id, finding_id, channel, ts, parent_ts, posted_at, last_updated_at)
      VALUES (42, 11, 'C1', 'ts', 'parent', datetime('now', '-25 hours'), NULL);
    `).run();
    expect(isFindingPostWindow(db, 11)).toBe(true);
  });

  test("returns false for a finding reply recorded just under 24 hours ago", () => {
    db.prepare(`
      INSERT INTO slack_finding_messages
        (run_id, finding_id, channel, ts, parent_ts, posted_at, last_updated_at)
      VALUES (42, 11, 'C1', 'ts', 'parent', datetime('now', '-23 hours'), NULL);
    `).run();
    expect(isFindingPostWindow(db, 11)).toBe(false);
  });
});
