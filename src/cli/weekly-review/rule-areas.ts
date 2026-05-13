/**
 * Allow-list of identifiers that an LLM finding may map to.
 *
 * Each value points at a real, tunable section of the detection logic
 * (`src/detection/ranking.ts` or `src/detection/detect.ts`) — except for
 * the two fallbacks `new_tunable_needed` and `unknown`. When `ranking.ts`
 * gains a new factor, append the matching identifier here. The agent's
 * system prompt interpolates this list at build time, so updating the
 * constant is enough — no prompt edit needed.
 */

import type { Logger } from "../../logger";

export const RULE_AREAS = [
  // ranking.ts (calculateTier)
  "ranking.ts:target_base_scores", // Home=4, 3B=3, 2B=1
  "ranking.ts:direct_throw_bonus", // segments.length === 2 -> +2
  "ranking.ts:video_bonus", // hasVideo -> +1
  "ranking.ts:overturn_penalty", // isOverturned -> -2
  "ranking.ts:tier_thresholds", // score >= 5 high, >= 3 medium, else low

  // detect.ts (detection eligibility)
  "detect.ts:outfield_codes", // which positions count as OF
  "detect.ts:skip_events", // event types excluded from detection

  // Fallbacks
  "new_tunable_needed", // pattern points at a factor the bot doesn't currently weight
  "unknown", // agent couldn't confidently map; flagged for prompt iteration
] as const;

export type RuleArea = (typeof RULE_AREAS)[number];

/**
 * Coerces an arbitrary string to a `RuleArea`. Values not in the
 * allow-list collapse to `"unknown"` and emit a warn so the operator
 * notices a drift between the prompt and the curated list.
 */
export function normalizeRuleArea(value: string, logger: Logger): RuleArea {
  if ((RULE_AREAS as readonly string[]).includes(value)) {
    return value as RuleArea;
  }
  logger.warn(
    "agent returned unknown suspected_rule_area; normalizing to 'unknown'",
    { value },
  );
  return "unknown";
}
