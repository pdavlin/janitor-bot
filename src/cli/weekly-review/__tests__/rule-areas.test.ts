import { test, expect, describe } from "bun:test";
import { createLogger } from "../../../logger";
import { RULE_AREAS, normalizeRuleArea } from "../rule-areas";

const silentLogger = createLogger("error");

describe("rule-areas allow-list", () => {
  test("includes the curated set", () => {
    expect(RULE_AREAS).toContain("ranking.ts:target_base_scores");
    expect(RULE_AREAS).toContain("ranking.ts:tier_thresholds");
    expect(RULE_AREAS).toContain("detect.ts:outfield_codes");
    expect(RULE_AREAS).toContain("new_tunable_needed");
    expect(RULE_AREAS).toContain("unknown");
  });

  test("normalizeRuleArea returns the value when it is in the list", () => {
    expect(normalizeRuleArea("ranking.ts:video_bonus", silentLogger)).toBe(
      "ranking.ts:video_bonus",
    );
  });

  test("normalizeRuleArea collapses unknown values to 'unknown'", () => {
    expect(normalizeRuleArea("ranking.ts:not_a_real_area", silentLogger)).toBe(
      "unknown",
    );
  });
});
