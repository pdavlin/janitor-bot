import { test, expect, describe } from "bun:test";
import { createLogger } from "../../../logger";
import { validateFindings } from "../validation";
import { buildTranscript, type Transcript } from "../types";

const silentLogger = createLogger("error");

const EMPTY_TRANSCRIPT: Transcript = buildTranscript([]);

const TRANSCRIPT_WITH_QUOTE: Transcript = buildTranscript([
  {
    gamePk: 100,
    headerTs: "1.000",
    truncated: false,
    messages: [
      {
        text: "channel literally said the runner was clearly safe by a step",
        user: "U1",
        ts: "1.001",
      },
    ],
  },
]);

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
    const result = validateFindings([baseFinding()], EMPTY_TRANSCRIPT, silentLogger);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("rejects when description contains a quote character", () => {
    const result = validateFindings(
      [baseFinding({ description: 'Channel said "this should be high"' })],
      EMPTY_TRANSCRIPT,
      silentLogger,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/quote/i);
  });

  test("rejects when description contains a Slack mention token", () => {
    const result = validateFindings(
      [baseFinding({ description: "Channel pushed back per <@U1234>" })],
      EMPTY_TRANSCRIPT,
      silentLogger,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/mention/i);
  });

  test("rejects on a 30-char substring match against a transcript message", () => {
    const verbatim = "the runner was clearly safe by a step";
    const result = validateFindings(
      [
        baseFinding({
          description: `Pattern observed: ${verbatim} on multiple replays this week`,
        }),
      ],
      TRANSCRIPT_WITH_QUOTE,
      silentLogger,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/substring/i);
  });

  test("rejects findings with a missing required field", () => {
    const result = validateFindings(
      [baseFinding({ severity: "weird" })],
      EMPTY_TRANSCRIPT,
      silentLogger,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/severity/i);
  });

  test("rejects findings with empty evidence_play_ids", () => {
    const result = validateFindings(
      [baseFinding({ evidence_play_ids: [] })],
      EMPTY_TRANSCRIPT,
      silentLogger,
    );
    expect(result.accepted).toHaveLength(0);
  });

  test("normalizes unknown rule_area to 'unknown' but still accepts", () => {
    const result = validateFindings(
      [baseFinding({ suspected_rule_area: "ranking.ts:not_a_real_area" })],
      EMPTY_TRANSCRIPT,
      silentLogger,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.suspected_rule_area).toBe("unknown");
  });

  test("treats a null trend as null (not a rejection)", () => {
    const result = validateFindings(
      [baseFinding({ trend: null })],
      EMPTY_TRANSCRIPT,
      silentLogger,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.trend).toBeNull();
  });
});
