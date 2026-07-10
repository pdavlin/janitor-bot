/**
 * Tier ranking for outfield assist plays.
 *
 * Assigns a "high", "medium", or "low" tier based on throw difficulty,
 * determined by the target base and whether the throw was direct or relayed.
 */

import type { Tier } from "../types/play";
export type { Tier } from "../types/play";

/**
 * Scoring constants for {@link calculateTier}. Exported so callers that
 * describe the rules to users (e.g. the /about page) can render the same
 * numbers the scorer uses, keeping copy and logic from drifting apart.
 */
/** Points for a runner cut down at home. */
export const SCORE_HOME = 4;
/** Points for a runner cut down at third. */
export const SCORE_3B = 3;
/** Points for any other target base (2B and legacy 1B rows). */
export const SCORE_OTHER_BASE = 1;
/** Bonus for a direct throw (exactly two fielders in the credit chain). */
export const DIRECT_THROW_BONUS = 2;
/** Penalty for a relay chain (3+ fielders, 1+ intermediary). */
export const LONG_RELAY_PENALTY = -2;
/** Bonus when a video clip is available. */
export const VIDEO_BONUS = 1;
/** Penalty when the out only stood because of a replay overturn. */
export const OVERTURN_PENALTY = -2;
/** Bonus applied to a tracked throw at or above the velocity threshold. */
export const VELOCITY_BONUS = 1;
/** Throw velocity (mph) at or above which the velocity bonus applies. */
export const VELOCITY_THRESHOLD_MPH = 95;
/** Minimum total score for the "high" tier. */
export const TIER_HIGH_MIN = 5;
/** Minimum total score for the "medium" tier (below this is "low"). */
export const TIER_MEDIUM_MIN = 3;

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
  if (mph >= VELOCITY_THRESHOLD_MPH) return VELOCITY_BONUS;
  return 0;
}

/**
 * Penalty for relay chains.
 *
 * Any credit chain of 3+ segments means at least one intermediary between
 * the outfielder and the tagging fielder (e.g. `RF -> SS -> C`). A six-week
 * engagement aggregate (weeks 2026-05-03 through 2026-06-14) showed relays
 * are dead across every target base: 0.00–0.05 fire/play versus 0.20–0.80
 * for direct throws to the same base, and relays absorbed the large majority
 * of the period's trash votes. Relay-to-Home was the worst offender — 11 of
 * 19 classified high, yet net-negative engagement.
 *
 * Originally scoped to 4+ segments only (run #7 finding 20, operator-
 * confirmed), with 3-segment cutoffs deliberately excluded because the
 * relay-to-Home-as-a-class finding for that run was rejected on a single
 * week's evidence (run #7 finding 17). The six-week aggregate reverses that:
 * single-cutoff relays are penalized too, since the class is consistently
 * unloved, not just the 4-segment tail.
 *
 * @param segmentCount - Number of fielders in the credit chain.
 * @returns Penalty points (<= 0) to add to the tier score.
 */
function longRelayPenalty(segmentCount: number): number {
  return segmentCount >= 3 ? LONG_RELAY_PENALTY : 0;
}

/**
 * Calculate the tier for an outfield assist play based on throw impressiveness.
 *
 * Scoring breakdown:
 *   - Target base:  Home = 4, 3B = 3, 2B = 1
 *   - Direct throw (no relay, 2 segments in credit chain): 2
 *   - Relay chain (3+ segments, 1+ intermediary): -2 (see longRelayPenalty)
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
    score += SCORE_HOME;
  } else if (play.targetBase === "3B") {
    score += SCORE_3B;
  } else {
    score += SCORE_OTHER_BASE;
  }

  // Direct throw bonus: exactly one " -> " means two players (fielder -> receiver)
  const segments = play.creditChain.split(" -> ");
  if (segments.length === 2) {
    score += DIRECT_THROW_BONUS;
  }

  // Relay penalty: 3+ fielders means 1+ intermediary (see longRelayPenalty)
  score += longRelayPenalty(segments.length);

  // Video availability bonus
  if (play.hasVideo) {
    score += VIDEO_BONUS;
  }

  // Overturn penalty: the out only exists because of a replay reversal.
  if (play.isOverturned) {
    score += OVERTURN_PENALTY;
  }

  // Throw velocity bonus (FR-1.10: absent velocity contributes 0)
  score += velocityBonus(play.throwVelocity);

  if (score >= TIER_HIGH_MIN) return "high";
  if (score >= TIER_MEDIUM_MIN) return "medium";
  return "low";
}
