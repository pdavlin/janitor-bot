/**
 * Builds the system + user prompts handed to the Anthropic Messages API.
 *
 * The system prompt is the contract: bot context, the goal (systematic
 * patterns covering 2+ plays), the hard rules (no quotes, no mentions,
 * no per-play tier verdicts), the JSON schema, the severity rubric,
 * the evidence-strength rubric, and the rule-area allow-list (pasted
 * verbatim from `RULE_AREAS`).
 *
 * The user prompt is a structured payload of plays + votes + tags +
 * transcripts + past findings + channel corrections. Hard rules echo
 * at the top of the user prompt as defense-in-depth.
 */

// transcript-leakage-allowed: prompt.ts is the legitimate consumer of
// transcript content — it formats the LLM prompt body. The
// check-no-transcript-leakage script enforces a stricter rule here:
// no persistence, logger, or Slack-API sinks are permitted in this
// file, so any future drift is caught.

import type { Baseline } from "./baseline";
import type {
  GatheredPlay,
  PlayTagRow,
  VoteSnapshotRow,
} from "./gather";
import type { FindingRow, Transcript, TranscriptMessage } from "./types";
import type { WeekWindow } from "./week-window";

export interface BuiltPrompt {
  system: string;
  user: string;
  /** 4-chars-per-token estimate of the input size (system + user). */
  estimatedInputTokens: number;
}

export interface BuildPromptInput {
  window: WeekWindow;
  baseline: Baseline;
  plays: readonly GatheredPlay[];
  snapshots: readonly VoteSnapshotRow[];
  tags: readonly PlayTagRow[];
  transcript: Transcript;
  channelCorrections: readonly TranscriptMessage[];
  priorFindings: readonly FindingRow[];
  ruleAreas: readonly string[];
}

const CHARS_PER_TOKEN = 4;

const HARD_RULES = `Output discipline (HARD RULES):
1. Do NOT quote or paraphrase user comments.
2. Do NOT include Slack mentions, URLs, or user IDs.
3. Describe patterns abstractly. Example: "channel pushed back on RF->Home throws" is good. "User X said '<text>'" is FORBIDDEN.
4. Output is strictly JSON matching the schema below; no prose outside it.
5. Do NOT issue per-play tier verdicts ("this play should have been medium"). That's the operator's job.
6. Do NOT propose code changes. Surface patterns; the operator decides.`;

const SCHEMA = `{ "findings": [
    { "finding_type": string,
      "description": string,
      "severity": "info" | "watch" | "act",
      "evidence_strength": "weak" | "moderate" | "strong",
      "evidence_play_ids": number[],
      "suspected_rule_area": <one of allow-list>,
      "trend": "first_seen" | "recurring" | "escalating" | "cooling" | null
    }, ... ] }`;

const SEVERITY_RUBRIC = `Severity rules (single-run grounded):
- info: 2-3 plays, mixed/unclear signal
- watch: >=4 plays, consistent directional signal
- act: clear majority disagreement with the classifier across affected plays`;

const STRENGTH_RUBRIC = `Evidence strength:
- weak: 2-3 plays
- moderate: 4-6 plays
- strong: 7+ plays`;

const TOOL_USE_GUIDE = `Tool use
========

You have access to read-only DB query tools. Use them to verify hypotheses
before emitting findings.

Available tools (see registry for full schemas):
- getVoteSnapshot(playId) — actual fire/trash/voter counts for a play
- getPlayDetails(playId) — tier/position/runners_on/credit_chain etc
- getThreadMessageCount(gamePk) — count of recorded thread messages
- getHistoricalFindingOutcomes(suspectedRuleArea, weeks) — confirmed/rejected counts
- getPriorFindingDescription(findingId) — full description of a past finding
- queryPlaysInWindow(filters) — filtered query for plays in this week
- getPlayTagsForPlay(playId) — phase 3 regex tags

Guidance: before claiming a vote count, engagement level, or pattern
recurrence, call the relevant tool. Findings whose claims are not
backed by tool calls may be dropped at validation in future runs.`;

function buildSystemPrompt(ruleAreas: readonly string[]): string {
  const allowList = ruleAreas.map((r) => `  - ${r}`).join("\n");
  return [
    "You are reviewing the past week of an MLB outfield-assist bot's classifications.",
    "The bot tiers each play (high/medium/low) using rules in src/detection/ranking.ts.",
    "Channel members react :fire: (great play) or :wastebasket: (overrated / mis-detected).",
    "",
    "Your job: identify SYSTEMATIC patterns covering 2+ plays — not per-play verdicts.",
    "Per-play tier judgments are votes' job. Code-change suggestions are the operator's job.",
    "",
    HARD_RULES,
    "",
    "Output JSON schema:",
    SCHEMA,
    "",
    SEVERITY_RUBRIC,
    "",
    STRENGTH_RUBRIC,
    "",
    "Allow-list for suspected_rule_area (pick the closest match):",
    allowList,
    "Use \"unknown\" if you cannot confidently map the pattern.",
    "Use \"new_tunable_needed\" if the pattern points at a factor the bot doesn't currently weight.",
    "",
    TOOL_USE_GUIDE,
  ].join("\n");
}

function renderPlays(plays: readonly GatheredPlay[]): string {
  return plays
    .map((p) =>
      JSON.stringify({
        id: p.id,
        date: p.date,
        gamePk: p.gamePk,
        playIndex: p.playIndex,
        position: p.fielderPosition,
        targetBase: p.targetBase,
        tier: p.tier,
        outs: p.outs,
        runnersOn: p.runnersOn,
        inning: p.inning,
        halfInning: p.halfInning,
        teams: `${p.awayTeam}@${p.homeTeam}`,
        creditChain: p.creditChain,
      }),
    )
    .join("\n");
}

function renderSnapshots(snapshots: readonly VoteSnapshotRow[]): string {
  return snapshots
    .map((s) =>
      JSON.stringify({
        gamePk: s.gamePk,
        playIndex: s.playIndex,
        fire: s.fireCount,
        trash: s.trashCount,
        net: s.netScore,
        voters: s.voterCount,
        flagged: s.tierReviewFlagged,
      }),
    )
    .join("\n");
}

function renderTags(tags: readonly PlayTagRow[]): string {
  if (tags.length === 0) return "";
  return tags
    .map((t) =>
      JSON.stringify({
        gamePk: t.gamePk,
        playIndex: t.playIndex,
        type: t.tagType,
        value: t.tagValue,
      }),
    )
    .join("\n");
}

function renderTranscript(transcript: Transcript): string {
  if (transcript.games.length === 0) return "(no thread transcripts available)";
  return transcript.games
    .map((g) => {
      const header = g.truncated
        ? `Game ${g.gamePk} (TRUNCATED — older messages omitted):`
        : `Game ${g.gamePk}:`;
      const lines = g.messages.map((m) => `  - ${m.text}`);
      return [header, ...lines].join("\n");
    })
    .join("\n\n");
}

function renderCorrections(corrections: readonly TranscriptMessage[]): string {
  if (corrections.length === 0) return "(no replies on prior digests)";
  const body = corrections.map((m) => `  - ${m.text}`).join("\n");
  return ["WEAK SIGNAL — interpret cautiously:", body].join("\n");
}

function renderPriorFindings(priorFindings: readonly FindingRow[]): string {
  if (priorFindings.length === 0) return "(no prior findings in window)";
  return priorFindings
    .map((f) =>
      JSON.stringify({
        week: f.week_starting,
        finding_type: f.finding_type,
        severity: f.severity,
        evidence_strength: f.evidence_strength,
        suspected_rule_area: f.suspected_rule_area,
        outcome: f.outcome,
        trend: f.trend,
      }),
    )
    .join("\n");
}

function buildUserPrompt(input: BuildPromptInput): string {
  const sections: string[] = [];
  sections.push("REMINDER OF HARD RULES (defense in depth — system prompt also enforces):");
  sections.push(HARD_RULES);

  sections.push("");
  sections.push(`## Window`);
  sections.push(`${input.window.weekStarting} to ${input.window.weekEnding} (Sunday-Saturday, America/Chicago)`);

  sections.push("");
  sections.push(`## Baseline`);
  sections.push(
    JSON.stringify({
      totalPlays: input.baseline.totalPlays,
      playsWithVotes: input.baseline.playsWithVotes,
      flaggedCount: input.baseline.flaggedCount,
      byTier: input.baseline.byTier,
      byPositionRunners: input.baseline.byPositionRunners,
      topPositive: input.baseline.topPositive.map((p) => ({
        playId: p.playId,
        netScore: p.netScore,
      })),
      topNegative: input.baseline.topNegative.map((p) => ({
        playId: p.playId,
        netScore: p.netScore,
      })),
    }),
  );

  sections.push("");
  sections.push(`## Plays`);
  sections.push(renderPlays(input.plays));

  sections.push("");
  sections.push(`## Vote snapshots`);
  sections.push(renderSnapshots(input.snapshots));

  if (input.tags.length > 0) {
    sections.push("");
    sections.push(`## Regex tags`);
    sections.push(renderTags(input.tags));
  }

  sections.push("");
  sections.push(`## Thread transcripts`);
  sections.push(renderTranscript(input.transcript));

  sections.push("");
  sections.push(`## Channel corrections`);
  sections.push(renderCorrections(input.channelCorrections));

  sections.push("");
  sections.push(`## Past findings (last weeks)`);
  sections.push(renderPriorFindings(input.priorFindings));

  return sections.join("\n");
}

/** Constructs both prompts and a token estimate for pre-call warning. */
export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const system = buildSystemPrompt(input.ruleAreas);
  const user = buildUserPrompt(input);
  return {
    system,
    user,
    estimatedInputTokens: Math.ceil((system.length + user.length) / CHARS_PER_TOKEN),
  };
}
