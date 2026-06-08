/**
 * Tier ranking for outfield assist plays.
 *
 * Assigns a "high", "medium", or "low" tier based on throw difficulty,
 * determined by the target base and whether the throw was direct or relayed.
 */

import type { Tier } from "../types/play";
export type { Tier } from "../types/play";

/**
 * The minimum fields needed from a detected play to calculate its tier.
 */
interface TierInput {
  targetBase: string;
  creditChain: string;
  hasVideo: boolean;
  isOverturned: boolean;
  /** Throw velocity in mph from Savant arm-strength data. Absent = no bonus. */
  throwVelocity?: number | null;
}

/**
 * Velocity-to-tier bonus mapping.
 *
 * **Bands are set from velocity-calibration.md (FR-1.13), not guessed.**
 * The values below are a conservative placeholder until the calibration
 * analysis runs against the prod DB copy. Once the analysis produces
 * data-derived bands, replace this function with the chosen mapping.
 *
 * Conservative default: +1 for any tracked throw >= 95 mph.
 * This keeps velocity as a minor lift that can tip a borderline play
 * without dominating existing factors.
 *
 * @param mph - Throw velocity in mph, or null/undefined if untracked.
 * @returns Bonus points to add to the tier score.
 */
function velocityBonus(mph: number | null | undefined): number {
  if (mph == null) return 0;
  if (mph >= 95) return 1;
  return 0;
}

/**
 * Penalty for long relay chains.
 *
 * A credit chain of 4+ segments means two or more intermediaries between
 * the outfielder and the tagging fielder (e.g. `LF -> SS -> C -> 3B`). The
 * channel reacts negatively to these regardless of target base: in the
 * weekly-review run for the week of 2026-05-31, the only trash vote of the
 * week landed on the single 4-segment chain, and the relay-chain-length
 * finding was operator-confirmed (run #7, finding 20).
 *
 * Scoped deliberately to 4+ segments only. Single-cutoff relays (3 segments,
 * one intermediary) are NOT penalized, because the relay-to-Home finding for
 * that same run was operator-rejected — the channel does not treat an ordinary
 * cutoff relay as less impressive as a class.
 *
 * @param segmentCount - Number of fielders in the credit chain.
 * @returns Penalty points (<= 0) to add to the tier score.
 */
function longRelayPenalty(segmentCount: number): number {
  return segmentCount >= 4 ? -2 : 0;
}

/**
 * Calculate the tier for an outfield assist play based on throw impressiveness.
 *
 * Scoring breakdown:
 *   - Target base:  Home = 4, 3B = 3, 2B = 1
 *   - Direct throw (no relay, 2 segments in credit chain): 2
 *   - Long relay chain (4+ segments, 2+ intermediaries): -2 (see longRelayPenalty)
 *   - Video available: 1
 *   - Out came via review overturn: -2 (community treats these as less impressive)
 *   - Throw velocity bonus: set from calibration analysis (see velocityBonus)
 *
 * Total mapped to tier: 5+ high, 3-4 medium, 0-2 low.
 *
 * @param play - Subset of play data needed for scoring.
 * @returns The calculated tier.
 */
export function calculateTier(play: TierInput): Tier {
  let score = 0;

  // Target base value
  if (play.targetBase === "Home") {
    score += 4;
  } else if (play.targetBase === "3B") {
    score += 3;
  } else {
    score += 1;
  }

  // Direct throw bonus: exactly one " -> " means two players (fielder -> receiver)
  const segments = play.creditChain.split(" -> ");
  if (segments.length === 2) {
    score += 2;
  }

  // Long relay penalty: 4+ fielders means 2+ intermediaries (see longRelayPenalty)
  score += longRelayPenalty(segments.length);

  // Video availability bonus
  if (play.hasVideo) {
    score += 1;
  }

  // Overturn penalty: the out only exists because of a replay reversal.
  if (play.isOverturned) {
    score -= 2;
  }

  // Throw velocity bonus (FR-1.10: absent velocity contributes 0)
  score += velocityBonus(play.throwVelocity);

  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}
