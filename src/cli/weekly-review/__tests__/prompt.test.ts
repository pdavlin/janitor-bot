import { test, expect, describe } from "bun:test";
import { buildPrompt } from "../prompt";
import { buildTranscript } from "../types";
import { RULE_AREAS } from "../rule-areas";
import type { GatheredPlay, VoteSnapshotRow, PlayTagRow } from "../gather";
import type { FindingRow } from "../types";

const WINDOW = { weekStarting: "2026-04-26", weekEnding: "2026-05-02" };

const EMPTY_BASELINE = {
  totalPlays: 0,
  playsWithVotes: 0,
  flaggedCount: 0,
  topPositive: [],
  topNegative: [],
  byTier: [],
  byPositionRunners: [],
};

const SAMPLE_PLAY: GatheredPlay = {
  id: 1,
  gamePk: 100,
  playIndex: 1,
  date: "2026-04-28",
  fielderPosition: "RF",
  targetBase: "Home",
  tier: "high",
  outs: 1,
  runnersOn: "1st",
  inning: 7,
  halfInning: "top",
  awayTeam: "LAD",
  homeTeam: "SFG",
  creditChain: "RF -> C",
  fetchStatus: null,
};

const SAMPLE_SNAPSHOT: VoteSnapshotRow = {
  gamePk: 100,
  playIndex: 1,
  fireCount: 3,
  trashCount: 1,
  netScore: 2,
  voterCount: 4,
  tierReviewFlagged: false,
};

describe("buildPrompt", () => {
  test("system prompt contains the hard rules and rule-area allow-list", () => {
    const built = buildPrompt({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      plays: [],
      snapshots: [],
      tags: [],
      transcript: buildTranscript([]),
      channelCorrections: [],
      priorFindings: [],
      ruleAreas: RULE_AREAS,
    });
    expect(built.system).toContain("HARD RULES");
    expect(built.system).toContain("Do NOT quote or paraphrase");
    expect(built.system).toContain("Do NOT include Slack mentions");
    expect(built.system).toContain("ranking.ts:target_base_scores");
    expect(built.system).toContain("unknown");
    expect(built.system).toContain("new_tunable_needed");
  });

  test("user prompt contains all sections in order", () => {
    const built = buildPrompt({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      plays: [SAMPLE_PLAY],
      snapshots: [SAMPLE_SNAPSHOT],
      tags: [],
      transcript: buildTranscript([]),
      channelCorrections: [],
      priorFindings: [],
      ruleAreas: RULE_AREAS,
    });
    const sectionOrder = [
      "## Window",
      "## Baseline",
      "## Plays",
      "## Vote snapshots",
      "## Thread transcripts",
      "## Channel corrections",
      "## Past findings",
    ];
    let last = -1;
    for (const heading of sectionOrder) {
      const idx = built.user.indexOf(heading);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  test("regex tags section is omitted when there are no tags", () => {
    const built = buildPrompt({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      plays: [SAMPLE_PLAY],
      snapshots: [SAMPLE_SNAPSHOT],
      tags: [],
      transcript: buildTranscript([]),
      channelCorrections: [],
      priorFindings: [],
      ruleAreas: RULE_AREAS,
    });
    expect(built.user).not.toContain("## Regex tags");
  });

  test("regex tags section appears when tags are provided", () => {
    const tag: PlayTagRow = {
      id: 1,
      gamePk: 100,
      playIndex: 1,
      tagType: "tier_dispute",
      tagValue: "should_be_high",
      commentTs: "1.001",
      commentUserId: "U1",
      matchedText: "",
      receivedAt: "2026-04-28T00:00:00Z",
    };
    const built = buildPrompt({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      plays: [SAMPLE_PLAY],
      snapshots: [SAMPLE_SNAPSHOT],
      tags: [tag],
      transcript: buildTranscript([]),
      channelCorrections: [],
      priorFindings: [],
      ruleAreas: RULE_AREAS,
    });
    expect(built.user).toContain("## Regex tags");
    expect(built.user).toContain("tier_dispute");
  });

  test("past findings render with outcome for context", () => {
    const finding: FindingRow = {
      id: 1,
      run_id: 1,
      finding_type: "rf_home_pushback",
      description: null,
      severity: "watch",
      evidence_strength: "moderate",
      evidence_play_ids: "[1,2,3,4]",
      suspected_rule_area: "ranking.ts:target_base_scores",
      trend: "first_seen",
      outcome: "confirmed",
      resolved_at: null,
      resolved_by_run_id: null,
      created_at: "2026-04-19T00:00:00Z",
      week_starting: "2026-04-19",
    };
    const built = buildPrompt({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      plays: [SAMPLE_PLAY],
      snapshots: [SAMPLE_SNAPSHOT],
      tags: [],
      transcript: buildTranscript([]),
      channelCorrections: [],
      priorFindings: [finding],
      ruleAreas: RULE_AREAS,
    });
    expect(built.user).toContain("## Past findings");
    expect(built.user).toContain("confirmed");
    expect(built.user).toContain("rf_home_pushback");
  });

  test("transcripts annotate truncated games", () => {
    const built = buildPrompt({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      plays: [SAMPLE_PLAY],
      snapshots: [SAMPLE_SNAPSHOT],
      tags: [],
      transcript: buildTranscript([
        {
          gamePk: 100,
          headerTs: "1.000",
          truncated: true,
          messages: [
            { user: "U1", text: "play was great", ts: "1.001" },
          ],
        },
      ]),
      channelCorrections: [],
      priorFindings: [],
      ruleAreas: RULE_AREAS,
    });
    expect(built.user).toContain("TRUNCATED");
  });

  test("estimated tokens scales roughly with prompt length", () => {
    const small = buildPrompt({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      plays: [],
      snapshots: [],
      tags: [],
      transcript: buildTranscript([]),
      channelCorrections: [],
      priorFindings: [],
      ruleAreas: RULE_AREAS,
    });
    const large = buildPrompt({
      window: WINDOW,
      baseline: EMPTY_BASELINE,
      plays: Array.from({ length: 50 }, () => SAMPLE_PLAY),
      snapshots: Array.from({ length: 50 }, () => SAMPLE_SNAPSHOT),
      tags: [],
      transcript: buildTranscript([]),
      channelCorrections: [],
      priorFindings: [],
      ruleAreas: RULE_AREAS,
    });
    expect(large.estimatedInputTokens).toBeGreaterThan(small.estimatedInputTokens);
  });
});
