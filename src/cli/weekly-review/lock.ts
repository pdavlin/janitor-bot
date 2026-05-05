/**
 * Per-week concurrent-run lock backed by `agent_runs.status='started'`.
 *
 * The schema has a partial unique index on `(week_starting) WHERE
 * status='started'`. Inserting a `started` row IS the lock; the same
 * row is later updated to `success` or `error` to release it. A second
 * concurrent invocation hits the partial index and fails with a
 * `SQLITE_CONSTRAINT_UNIQUE` error, which we translate to a typed
 * `ConcurrentRunError`.
 */

import type { Database } from "bun:sqlite";
import type { RunStatus } from "./types";

export class ConcurrentRunError extends Error {
  readonly weekStarting: string;
  constructor(weekStarting: string) {
    super(
      `Another weekly-review run is in progress for week ${weekStarting}. ` +
        `Try --force-clear-stale-lock if you believe it's stuck.`,
    );
    this.name = "ConcurrentRunError";
    this.weekStarting = weekStarting;
  }
}

export interface LockHandle {
  runId: number;
  /**
   * Updates the run row's `status` and `completed_at`. Idempotent: a
   * second call is a SQL no-op via the unchanged WHERE clause; callers
   * still expect to call this exactly once.
   */
  release(status: Exclude<RunStatus, "started">, errorText?: string): void;
}

/**
 * Acquires the per-week lock by inserting a `status='started'` row into
 * `agent_runs`. Returns a handle whose `runId` is the inserted row's id
 * and whose `release` method transitions the row to `success`/`error`.
 */
export function acquireLock(
  db: Database,
  weekStarting: string,
  model: string,
): LockHandle {
  let row: { id: number };
  try {
    row = db
      .prepare(
        `
        INSERT INTO agent_runs (week_starting, model, started_at, status)
        VALUES ($week, $model, datetime('now'), 'started')
        RETURNING id;
      `,
      )
      .get({ $week: weekStarting, $model: model }) as { id: number };
  } catch (err) {
    if (isSqliteUniqueConstraintError(err)) {
      throw new ConcurrentRunError(weekStarting);
    }
    throw err;
  }

  const runId = row.id;
  return {
    runId,
    release(status, errorText) {
      db.prepare(
        `
        UPDATE agent_runs
        SET status = $status, completed_at = datetime('now'), error_text = $err
        WHERE id = $id;
      `,
      ).run({
        $status: status,
        $err: errorText ?? null,
        $id: runId,
      });
    },
  };
}

/**
 * Detects bun:sqlite's UNIQUE-constraint error.
 *
 * bun:sqlite throws a plain `Error` whose `code` field is a string like
 * `"SQLITE_CONSTRAINT_UNIQUE"`. There's no dedicated subclass to
 * `instanceof` against, so we encode the guard inline.
 */
function isSqliteUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

/**
 * Deletes any `started` rows for the given week that are older than
 * `olderThanHours`. Used by `--force-clear-stale-lock` after a crashed
 * run leaves a hung row. Safe to delete because findings can only be
 * persisted after the LLM call returns; a still-`started` row therefore
 * has no findings to lose.
 */
export function clearStaleLock(
  db: Database,
  weekStarting: string,
  olderThanHours = 1,
): number {
  const result = db
    .prepare(
      `
      DELETE FROM agent_runs
      WHERE week_starting = $week
        AND status = 'started'
        AND started_at < datetime('now', $offset);
    `,
    )
    .run({
      $week: weekStarting,
      $offset: `-${olderThanHours} hours`,
    });
  return Number(result.changes);
}
