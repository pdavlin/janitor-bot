/**
 * Value domains for the tier/position/base play filters.
 *
 * Single source for the JSON API's validation sets (routes.ts) and the
 * gallery form's option lists (pages/highlights.ts), so the accepted
 * values and the offered options can't drift apart.
 *
 * Legacy 1B note: rows with target_base = "1B" exist and /season displays
 * them, but 1B is deliberately not an accepted filter value (detection no
 * longer emits 1B-target plays), so it stays out of BASE_OPTIONS.
 */

import type { Tier } from "../types/play";

/** Tier filter values, in display order (high first). */
export const TIER_OPTIONS: readonly Tier[] = ["high", "medium", "low"];

/** Outfield position filter values, in display order. */
export const POSITION_OPTIONS: readonly string[] = ["LF", "CF", "RF"];

/** Target base filter values, in display order. */
export const BASE_OPTIONS: readonly string[] = ["2B", "3B", "Home"];
