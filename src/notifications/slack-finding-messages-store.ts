/**
 * Persistence helpers for the slack_finding_messages table.
 *
 * One row per (run_id, finding_id): the thread-reply ts under the weekly
 * digest header where users react with :white_check_mark: / :x: to confirm
 * or reject a finding. The reverse (channel, ts) lookup feeds the reaction
 * dispatcher so an inbound reaction maps back to the originating finding.
 *
 * Pattern mirrors slack-messages-store.ts.
 */

import type { Database } from "bun:sqlite";

/** Reference to a single finding's thread reply, with its parent header ts. */
export interface SlackFindingMessageRef {
  channel: string;
  ts: string;
  parentTs: string;
  runId: number;
  findingId: number;
}

/**
 * Records the channel + ts of a freshly posted finding thread reply.
 *
 * Idempotent on (run_id, finding_id): a re-post upserts the latest channel/ts
 * and resets last_updated_at because the new reply has not yet been edited.
 */
export function recordFindingMessage(
  db: Database,
  runId: number,
  findingId: number,
  channel: string,
  ts: string,
  parentTs: string,
): void {
  db.prepare(`
    INSERT INTO slack_finding_messages (run_id, finding_id, channel, ts, parent_ts, posted_at, last_updated_at)
    VALUES ($runId, $findingId, $channel, $ts, $parentTs, datetime('now'), NULL)
    ON CONFLICT(run_id, finding_id) DO UPDATE SET
      channel = excluded.channel,
      ts = excluded.ts,
      parent_ts = excluded.parent_ts,
      posted_at = excluded.posted_at,
      last_updated_at = NULL;
  `).run({
    $runId: runId,
    $findingId: findingId,
    $channel: channel,
    $ts: ts,
    $parentTs: parentTs,
  });
}

/**
 * Looks up the finding-reply reference for a (runId, findingId).
 * Returns null when no reply was recorded.
 */
export function lookupFindingMessage(
  db: Database,
  runId: number,
  findingId: number,
): SlackFindingMessageRef | null {
  const row = db
    .prepare(`
      SELECT channel, ts, parent_ts FROM slack_finding_messages
      WHERE run_id = $runId AND finding_id = $findingId;
    `)
    .get({ $runId: runId, $findingId: findingId }) as
    | { channel: string; ts: string; parent_ts: string }
    | null;
  return row
    ? {
        channel: row.channel,
        ts: row.ts,
        parentTs: row.parent_ts,
        runId,
        findingId,
      }
    : null;
}

/**
 * Reverse lookup from a (channel, ts) — used by the reaction dispatcher to
 * map an incoming Slack reaction back to the (runId, findingId) it belongs to.
 */
export function lookupFindingMessageByTs(
  db: Database,
  channel: string,
  ts: string,
): { runId: number; findingId: number } | null {
  const row = db
    .prepare(`
      SELECT run_id, finding_id FROM slack_finding_messages
      WHERE channel = $channel AND ts = $ts;
    `)
    .get({ $channel: channel, $ts: ts }) as
    | { run_id: number; finding_id: number }
    | null;
  return row ? { runId: row.run_id, findingId: row.finding_id } : null;
}
