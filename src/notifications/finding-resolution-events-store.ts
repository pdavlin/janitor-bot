/**
 * Persistence helpers for the finding_resolution_events log.
 *
 * The table is append-only. One row per Slack reaction_added /
 * reaction_removed event on a finding thread reply. Phase 1 only writes
 * here; the snapshot job that folds these events into agent_findings.outcome
 * lives in phase 2.
 *
 * Pattern mirrors slack-votes-store.ts (without computeFindingTally — that
 * is phase 2's snapshot job).
 */

import type { Database } from "bun:sqlite";

/** A reaction direction the bot recognises as a finding resolution vote. */
export type ResolutionDirection = "confirm" | "reject";

/** Slack reaction events come in two flavours: added and removed. */
export type ResolutionAction = "added" | "removed";

const REACTION_TO_RESOLUTION: Record<string, ResolutionDirection> = {
  white_check_mark: "confirm",
  x: "reject",
};

/**
 * Maps a Slack reaction name to a resolution direction. Returns null when
 * the reaction is not a recognised resolution vote (any other emoji is
 * ignored). Disjoint from reactionToDirection in slack-votes-store: play
 * votes use fire/wastebasket, finding resolutions use white_check_mark/x.
 */
export function reactionToResolutionDirection(
  reaction: string,
): ResolutionDirection | null {
  return REACTION_TO_RESOLUTION[reaction] ?? null;
}

/** Single reaction event ready to insert into the resolution log. */
export interface FindingResolutionEvent {
  findingId: number;
  userId: string;
  direction: ResolutionDirection;
  action: ResolutionAction;
  /** Slack `event_ts` from the envelope; preserved verbatim. */
  eventTs: string;
  /** True when the reaction arrived after the 24h post window. */
  postWindow: boolean;
}

/**
 * Inserts a single resolution event row. The table has no UNIQUE constraints
 * because the same (user, finding, direction) tuple can legitimately appear
 * multiple times across an add/remove/re-add sequence.
 */
export function insertFindingResolutionEvent(
  db: Database,
  evt: FindingResolutionEvent,
): void {
  db.prepare(`
    INSERT INTO finding_resolution_events
      (finding_id, user_id, direction, action, event_ts, received_at, post_window)
    VALUES
      ($findingId, $userId, $direction, $action, $eventTs, datetime('now'), $postWindow);
  `).run({
    $findingId: evt.findingId,
    $userId: evt.userId,
    $direction: evt.direction,
    $action: evt.action,
    $eventTs: evt.eventTs,
    $postWindow: evt.postWindow ? 1 : 0,
  });
}

/**
 * Returns true when the finding's 24-hour post window has elapsed (so any
 * reactions arriving now are after-the-fact).
 *
 * Returns false when the finding has no slack_finding_messages row — without
 * a known posted_at, treat the event as in-window so the tally is at least
 * preserved if the row gets written later.
 */
export function isFindingPostWindow(
  db: Database,
  findingId: number,
): boolean {
  const row = db.prepare(`
    SELECT (datetime(posted_at, '+24 hours') < datetime('now')) AS past
    FROM slack_finding_messages
    WHERE finding_id = $findingId;
  `).get({ $findingId: findingId }) as { past: number } | null;
  return row?.past === 1;
}
