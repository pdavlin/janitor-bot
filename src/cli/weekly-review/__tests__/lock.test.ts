import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../../storage/db";
import { acquireLock, clearStaleLock, ConcurrentRunError } from "../lock";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("acquireLock / release", () => {
  test("first acquire returns a positive runId and inserts a 'started' row", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-7");
    expect(lock.runId).toBeGreaterThan(0);

    const row = db
      .prepare(`SELECT status, model FROM agent_runs WHERE id = $id;`)
      .get({ $id: lock.runId }) as { status: string; model: string };
    expect(row.status).toBe("started");
    expect(row.model).toBe("claude-sonnet-4-7");
  });

  test("second concurrent acquire for the same week throws ConcurrentRunError", () => {
    acquireLock(db, "2026-04-26", "claude-sonnet-4-7");
    expect(() => acquireLock(db, "2026-04-26", "claude-sonnet-4-7")).toThrow(
      ConcurrentRunError,
    );
  });

  test("release transitions status to success and stamps completed_at", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-7");
    lock.release("success");

    const row = db
      .prepare(
        `SELECT status, completed_at, error_text FROM agent_runs WHERE id = $id;`,
      )
      .get({ $id: lock.runId }) as {
      status: string;
      completed_at: string | null;
      error_text: string | null;
    };
    expect(row.status).toBe("success");
    expect(row.completed_at).not.toBeNull();
    expect(row.error_text).toBeNull();
  });

  test("release stores error_text when provided", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-7");
    lock.release("error", "boom");

    const row = db
      .prepare(`SELECT status, error_text FROM agent_runs WHERE id = $id;`)
      .get({ $id: lock.runId }) as { status: string; error_text: string };
    expect(row.status).toBe("error");
    expect(row.error_text).toBe("boom");
  });

  test("after release, a fresh acquire for the same week succeeds", () => {
    const first = acquireLock(db, "2026-04-26", "claude-sonnet-4-7");
    first.release("success");
    const second = acquireLock(db, "2026-04-26", "claude-sonnet-4-7");
    expect(second.runId).toBeGreaterThan(first.runId);
  });
});

describe("clearStaleLock", () => {
  test("deletes started rows older than the threshold", () => {
    db.run(
      `INSERT INTO agent_runs (week_starting, model, started_at, status)
       VALUES ('2026-04-26', 'claude-sonnet-4-7', datetime('now', '-2 hours'), 'started');`,
    );
    const deleted = clearStaleLock(db, "2026-04-26", 1);
    expect(deleted).toBe(1);
  });

  test("leaves fresh started rows in place", () => {
    acquireLock(db, "2026-04-26", "claude-sonnet-4-7");
    const deleted = clearStaleLock(db, "2026-04-26", 1);
    expect(deleted).toBe(0);
  });

  test("does not touch non-started rows", () => {
    const lock = acquireLock(db, "2026-04-26", "claude-sonnet-4-7");
    lock.release("error", "old failure");
    db.run(
      `UPDATE agent_runs SET started_at = datetime('now', '-3 hours') WHERE id = ${lock.runId};`,
    );
    const deleted = clearStaleLock(db, "2026-04-26", 1);
    expect(deleted).toBe(0);
  });
});
