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
}

/**
 * Calculate the tier for an outfield assist play based on throw impressiveness.
 *
 * Scoring breakdown:
 *   - Target base:  Home = 4, 3B = 3, 2B = 1
 *   - Direct throw (no relay, 2 segments in credit chain): 2
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

  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}
