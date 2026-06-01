import { test, expect, describe } from "bun:test";
import { createLogger } from "../../../logger";
import { validateFindings } from "../validation";

const silentLogger = createLogger("error");

function baseFinding(overrides: Record<string, unknown> = {}): unknown {
  return {
    finding_type: "rf_home_pushback",
    description: "Channel pushed back on RF to Home throws across multiple plays.",
    severity: "watch",
    evidence_strength: "moderate",
    evidence_play_ids: [1, 2, 3, 4],
    suspected_rule_area: "ranking.ts:target_base_scores",
    trend: "first_seen",
    ...overrides,
  };
}

describe("validateFindings", () => {
  test("accepts a clean finding", () => {
    const result = validateFindings([baseFinding()], silentLogger);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("accepts a finding that quotes channel discussion", () => {
    const result = validateFindings(
      [
        baseFinding({
          description:
            'A member withheld fire, noting "the throw never left his feet" on the cutoff.',
        }),
      ],
      silentLogger,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("accepts a description with apostrophes and possessives", () => {
    const result = validateFindings(
      [
        baseFinding({
          description:
            "This week's longest relay chain didn't draw any votes from the channel.",
        }),
      ],
      silentLogger,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("rejects when description contains a Slack mention token", () => {
    const result = validateFindings(
      [baseFinding({ description: "Channel pushed back per <@U1234>" })],
      silentLogger,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/mention/i);
  });

  test("rejects when description contains a URL", () => {
    const result = validateFindings(
      [
        baseFinding({
          description:
            "A member posted a corrected clip at https://example.com/reel for the play.",
        }),
      ],
      silentLogger,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/url/i);
  });

  test("rejects findings with a missing required field", () => {
    const result = validateFindings(
      [baseFinding({ severity: "weird" })],
      silentLogger,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/severity/i);
  });

  test("rejects findings with empty evidence_play_ids", () => {
    const result = validateFindings(
      [baseFinding({ evidence_play_ids: [] })],
      silentLogger,
    );
    expect(result.accepted).toHaveLength(0);
  });

  test("normalizes unknown rule_area to 'unknown' but still accepts", () => {
    const result = validateFindings(
      [baseFinding({ suspected_rule_area: "ranking.ts:not_a_real_area" })],
      silentLogger,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.suspected_rule_area).toBe("unknown");
  });

  test("treats a null trend as null (not a rejection)", () => {
    const result = validateFindings(
      [baseFinding({ trend: null })],
      silentLogger,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.trend).toBeNull();
  });
});
