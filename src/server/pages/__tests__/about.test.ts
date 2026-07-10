/**
 * Ties the /about tier-scoring explainer to src/detection/ranking.ts.
 *
 * The about page hand-describes the scoring rules and walks one worked
 * example. These tests make that copy a live contract with the scorer:
 *   1. the worked example is scored by the real calculateTier, so the tier
 *      the page claims can't silently diverge from the code; and
 *   2. the numbers printed in the copy are asserted against the exported
 *      ranking constants, so changing a point value fails here until the
 *      copy (which interpolates the same constants) is regenerated.
 */

import { test, expect, describe } from "bun:test";
import { renderAboutPage } from "../about";
import {
  calculateTier,
  SCORE_HOME,
  SCORE_3B,
  SCORE_OTHER_BASE,
  DIRECT_THROW_BONUS,
  LONG_RELAY_PENALTY,
  VIDEO_BONUS,
  OVERTURN_PENALTY,
  VELOCITY_BONUS,
  VELOCITY_THRESHOLD_MPH,
  TIER_HIGH_MIN,
  TIER_MEDIUM_MIN,
} from "../../../detection/ranking";

describe("about page tier-scoring contract", () => {
  test("the worked example scores the tier the page claims", () => {
    // RF -> SS -> C relay to Home with video, no overturn, no velocity.
    const tier = calculateTier({
      targetBase: "Home",
      creditChain: "RF -> SS -> C",
      hasVideo: true,
      isOverturned: false,
    });
    // Page copy renders this example with tierBadge("medium").
    expect(tier).toBe("medium");

    // And the arithmetic the page prints must sum to a medium total.
    const shownScore = SCORE_HOME + LONG_RELAY_PENALTY + VIDEO_BONUS;
    expect(shownScore).toBeGreaterThanOrEqual(TIER_MEDIUM_MIN);
    expect(shownScore).toBeLessThan(TIER_HIGH_MIN);
  });

  test("the copy prints the numbers the scorer actually uses", () => {
    const body = renderAboutPage();
    const relayMag = Math.abs(LONG_RELAY_PENALTY);
    const overturnMag = Math.abs(OVERTURN_PENALTY);

    expect(body).toContain(
      `Home ${SCORE_HOME}, 3B ${SCORE_3B}, 2B ${SCORE_OTHER_BASE}`,
    );
    expect(body).toContain(`A direct throw adds ${DIRECT_THROW_BONUS}`);
    expect(body).toContain(`3+ fielders subtracts ${relayMag}`);
    expect(body).toContain(`Available video adds ${VIDEO_BONUS}`);
    expect(body).toContain(`replay overturn subtracts ${overturnMag}`);
    expect(body).toContain(`${VELOCITY_THRESHOLD_MPH}+ mph adds ${VELOCITY_BONUS}`);
    expect(body).toContain(`(${TIER_HIGH_MIN}+)`);
    expect(body).toContain(`(${TIER_MEDIUM_MIN}&ndash;${TIER_HIGH_MIN - 1})`);
    expect(body).toContain(`(0&ndash;${TIER_MEDIUM_MIN - 1})`);
  });
});
