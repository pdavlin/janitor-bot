import { test, expect, describe } from "bun:test";
import {
  buildDigest,
  buildInsufficientDigest,
  buildEmptyDigest,
  buildAllRejectedDigest,
  orderFindings,
  byMinStrength,
} from "../digest";
import type { Finding, HitRate } from "../types";

const WINDOW = { weekStarting: "2026-04-26", weekEnding: "2026-05-02" };

const EMPTY_BASELINE = {
  totalPlays: 10,
  playsWithVotes: 8,
  flaggedCount: 2,
  topPositive: [{ playId: 11, netScore: 4, description: "RF -> Home" }],
  topNegative: [],
  byTier: [
    { tier: "high" as const, fireTotal: 8, trashTotal: 4 },
  ],
  byPositionRunners: [],
};

const HIT_RATE_INSUFFICIENT: HitRate = { confirmed: 0, total: 0 };
const HIT_RATE_RICH: HitRate = { confirmed: 6, total: 8 };

function finding(overrides: Partial<Finding> = {}): Finding {
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

describe("orderFindings", () => {
  test("sorts severity desc, then evidence_strength desc, then play count desc", () => {
    const items = [
      finding({ finding_type: "weak_info", severity: "info", evidence_strength: "weak", evidence_play_ids: [1, 2] }),
      finding({ finding_type: "act_strong_5", severity: "act", evidence_strength: "strong", evidence_play_ids: [1, 2, 3, 4, 5] }),
      finding({ finding_type: "act_moderate_4", severity: "act", evidence_strength: "moderate", evidence_play_ids: [1, 2, 3, 4] }),
      finding({ finding_type: "watch_strong_3", severity: "watch", evidence_strength: "strong", evidence_play_ids: [1, 2, 3] }),
    ];
    const ordered = orderFindings(items);
    expect(ordered.map((f) => f.finding_type)).toEqual([
      "act_strong_5",
      "act_moderate_4",
      "watch_strong_3",
      "weak_info",
    ]);
  });
});

describe("byMinStrength", () => {
  test("filters below threshold", () => {
    const items = [
      finding({ evidence_strength: "weak" }),
      finding({ evidence_strength: "moderate" }),
      finding({ evidence_strength: "strong" }),
    ];
    expect(items.filter(byMinStrength("moderate")).map((f) => f.evidence_strength))
      .toEqual(["moderate", "strong"]);
    expect(items.filter(byMinStrength("strong")).map((f) => f.evidence_strength))
      .toEqual(["strong"]);
  });

  test("default keeps everything", () => {
    const items = [finding({ evidence_strength: "weak" })];
    expect(items.filter(byMinStrength()).length).toBe(1);
  });
});

describe("buildDigest", () => {
  test("includes header, summary, baseline, findings list, and resolve hint", () => {
    const message = buildDigest({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      findings: [finding()],
      hitRate: HIT_RATE_RICH,
      runId: 42,
    });
    expect(message).toContain("Weekly classification review");
    expect(message).toContain("Summary:");
    expect(message).toContain("Baseline:");
    expect(message).toContain("Findings (1)");
    expect(message).toContain("ranking.ts:target_base_scores");
    expect(message).toContain("--resolve 42");
  });

  test("truncates a description longer than 280 chars", () => {
    const long = "a".repeat(400);
    const message = buildDigest({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      findings: [finding({ description: long })],
      hitRate: HIT_RATE_RICH,
      runId: 1,
    });
    expect(message).toContain("…");
    expect(message.includes("a".repeat(400))).toBe(false);
  });

  test("hit-rate footer says insufficient data when fewer than 5 resolved", () => {
    const message = buildDigest({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      findings: [finding()],
      hitRate: HIT_RATE_INSUFFICIENT,
      runId: 1,
    });
    expect(message).toContain("insufficient data");
  });
});

describe("alternate digests", () => {
  test("insufficient digest mentions counts", () => {
    expect(buildInsufficientDigest(WINDOW, 3, 2)).toContain(
      "Insufficient data this week — 3 plays, 2 votes",
    );
  });

  test("empty digest contains the no-patterns phrase", () => {
    expect(buildEmptyDigest(WINDOW, EMPTY_BASELINE, HIT_RATE_RICH)).toContain(
      "No systematic patterns detected this week.",
    );
  });

  test("all-rejected digest cites the rejection count", () => {
    expect(
      buildAllRejectedDigest(WINDOW, EMPTY_BASELINE, HIT_RATE_RICH, 4),
    ).toContain("4 findings failed output validation");
  });
});
