/**
 * Vote snapshot job.
 *
 * Locks the tally for plays whose 24-hour post window has elapsed and which
 * don't already have a snapshot row. The job is run on a fixed interval by
 * `runSnapshotLoop` (peer task to the main scheduler) and is idempotent —
 * re-running picks up where it left off without rewriting existing rows.
 *
 * Tier-review flag rule: when the channel disagrees with the bot's detected
 * tier (2+ trash on a high/medium play, or 2+ fire on a low play), the
 * snapshot is flagged with a reason for the operator to review.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../logger";
import type { Tier } from "../types/play";
import { computePlayTally } from "../notifications/slack-votes-store";

/** Minimum number of contradicting votes that triggers a review flag. */
const TIER_REVIEW_THRESHOLD = 2;

/**
 * Runs one pass of the snapshot job. Selects plays that are past their 24h
 * window and lack a snapshot, computes each one's tally, and inserts a
 * snapshot row.
 */
export function runSnapshotCycle(db: Database, logger: Logger): void {
  const due = db.prepare(`
    SELECT spm.game_pk, spm.play_index
    FROM slack_play_messages spm
    LEFT JOIN vote_snapshots vs
      ON vs.game_pk = spm.game_pk AND vs.play_index = spm.play_index
    WHERE vs.game_pk IS NULL
      AND datetime(spm.posted_at, '+24 hours') <= datetime('now');
  `).all() as { game_pk: number; play_index: number }[];

  for (const { game_pk, play_index } of due) {
    try {
      snapshotPlay(db, game_pk, play_index, logger);
    } catch (err) {
      logger.error("snapshot failed for play", {
        gamePk: game_pk,
        playIndex: play_index,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (due.length > 0) {
    logger.info("snapshots written", { count: due.length });
  }
}

/**
 * Computes a single play's snapshot row and writes it. Reads the play's
 * detected tier so the tier-review flag logic can compare. Skipped (with
 * a warning) when the underlying play row is missing.
 */
function snapshotPlay(
  db: Database,
  gamePk: number,
  playIndex: number,
  logger: Logger,
): void {
  const tally = computePlayTally(db, gamePk, playIndex, true);
  const playRow = db.prepare(`
    SELECT tier FROM plays
    WHERE game_pk = $gamePk AND play_index = $playIndex
    LIMIT 1;
  `).get({ $gamePk: gamePk, $playIndex: playIndex }) as { tier: Tier } | null;

  if (!playRow) {
    logger.warn("snapshot: play row missing", { gamePk, playIndex });
    return;
  }

  const flag = computeTierReviewFlag(playRow.tier, tally.fire, tally.trash);

  db.prepare(`
    INSERT INTO vote_snapshots (
      game_pk, play_index, fire_count, trash_count, net_score, voter_count,
      snapshotted_at, tier_review_flagged, tier_review_reason
    ) VALUES (
      $gamePk, $playIndex, $fire, $trash, $net, $voters, datetime('now'), $flagged, $reason
    )
    ON CONFLICT(game_pk, play_index) DO NOTHING;
  `).run({
    $gamePk: gamePk,
    $playIndex: playIndex,
    $fire: tally.fire,
    $trash: tally.trash,
    $net: tally.fire - tally.trash,
    $voters: tally.voters.size,
    $flagged: flag.flagged ? 1 : 0,
    $reason: flag.reason,
  });
}

interface TierReviewFlag {
  flagged: boolean;
  reason: string | null;
}

/**
 * Decides whether a snapshot should be flagged for tier review.
 *
 * - Detected high/medium with 2+ channel trashes -> flag (channel disagrees down).
 * - Detected low with 2+ channel fires -> flag (channel disagrees up).
 * - Otherwise no flag.
 */
function computeTierReviewFlag(
  tier: Tier,
  fire: number,
  trash: number,
): TierReviewFlag {
  if ((tier === "high" || tier === "medium") && trash >= TIER_REVIEW_THRESHOLD) {
    return { flagged: true, reason: "channel_disagrees_high_or_medium" };
  }
  if (tier === "low" && fire >= TIER_REVIEW_THRESHOLD) {
    return { flagged: true, reason: "channel_disagrees_low" };
  }
  return { flagged: false, reason: null };
}

/**
 * Long-running peer task that re-runs the snapshot job at a fixed interval.
 *
 * Sleep is sliced into 1-second checks so a shutdown signal is honoured
 * within ~1s. Failures inside a cycle are logged; the loop continues on
 * the next tick.
 */
export async function runSnapshotLoop(
  db: Database,
  logger: Logger,
  intervalMs: number,
  shouldStop: () => boolean,
): Promise<void> {
  while (!shouldStop()) {
    try {
      runSnapshotCycle(db, logger);
    } catch (err) {
      logger.error("snapshot cycle threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const sleepStart = Date.now();
    while (Date.now() - sleepStart < intervalMs && !shouldStop()) {
      await Bun.sleep(1000);
    }
  }
}
