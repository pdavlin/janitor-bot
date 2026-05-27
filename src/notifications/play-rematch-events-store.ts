/**
 * Persistence helpers for the play_rematch_events log.
 *
 * Append-only audit trail for every :repeat: reaction the bot processes.
 * One row per orchestrator invocation, including the dedupe short-circuit
 * so we can analyse how often users tap stale reactions.
 */

import type { Database } from "bun:sqlite";

/** Outcome of a single re-match attempt. */
export type RematchDecision = "swapped" | "agreed" | "no_match" | "deduped";

/** Single re-match event ready to insert into the audit log. */
export interface PlayRematchEvent {
  gamePk: number;
  playIndex: number;
  userId: string;
  priorVideoUrl: string | null;
  newVideoUrl: string | null;
  decision: RematchDecision;
  agentReason: string | null;
  eventTs: string;
}

/**
 * Inserts a single re-match event row. The table has no UNIQUE constraints
 * — every reaction tap legitimately produces a row, including duplicates
 * recorded as `deduped`.
 */
export function insertPlayRematchEvent(
  db: Database,
  evt: PlayRematchEvent,
): void {
  db.prepare(`
    INSERT INTO play_rematch_events
      (game_pk, play_index, user_id, prior_video_url, new_video_url,
       decision, agent_reason, event_ts)
    VALUES
      ($gamePk, $playIndex, $userId, $priorVideoUrl, $newVideoUrl,
       $decision, $agentReason, $eventTs);
  `).run({
    $gamePk: evt.gamePk,
    $playIndex: evt.playIndex,
    $userId: evt.userId,
    $priorVideoUrl: evt.priorVideoUrl,
    $newVideoUrl: evt.newVideoUrl,
    $decision: evt.decision,
    $agentReason: evt.agentReason,
    $eventTs: evt.eventTs,
  });
}

/**
 * Returns the most recent event for a (game_pk, play_index), or null when
 * no event has been recorded yet. Used by the orchestrator to short-circuit
 * repeat taps that target the same underlying state.
 */
export function getLatestRematchEvent(
  db: Database,
  gamePk: number,
  playIndex: number,
): PlayRematchEvent | null {
  const row = db
    .prepare(`
      SELECT game_pk, play_index, user_id, prior_video_url, new_video_url,
             decision, agent_reason, event_ts
      FROM play_rematch_events
      WHERE game_pk = $gamePk AND play_index = $playIndex
      ORDER BY id DESC
      LIMIT 1;
    `)
    .get({ $gamePk: gamePk, $playIndex: playIndex }) as
    | {
        game_pk: number;
        play_index: number;
        user_id: string;
        prior_video_url: string | null;
        new_video_url: string | null;
        decision: RematchDecision;
        agent_reason: string | null;
        event_ts: string;
      }
    | null;
  if (!row) return null;
  return {
    gamePk: row.game_pk,
    playIndex: row.play_index,
    userId: row.user_id,
    priorVideoUrl: row.prior_video_url,
    newVideoUrl: row.new_video_url,
    decision: row.decision,
    agentReason: row.agent_reason,
    eventTs: row.event_ts,
  };
}
