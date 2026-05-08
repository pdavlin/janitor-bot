/**
 * Tool registry for the weekly-review agent.
 *
 * Each entry is the SDK's `Tool` shape: `name` is what the agent
 * invokes, `input_schema` is JSON Schema, `description` is the only
 * documentation the agent sees about a tool. Descriptions are
 * intentionally prescriptive (when to call, what each input means,
 * what the return shape is).
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages";

export const WEEKLY_REVIEW_TOOLS: Tool[] = [
  {
    name: "getVoteSnapshot",
    description:
      "Returns the recorded fire/trash/voter counts for a play from the vote_snapshots table. " +
      "Call this before claiming a specific vote count or community-reaction level on a play. " +
      "If the play exists but has no snapshot row, the counts come back as 0 — that means " +
      "no recorded votes, which is itself a meaningful signal.",
    input_schema: {
      type: "object",
      properties: {
        playId: {
          type: "number",
          description: "The plays.id value from evidence_play_ids.",
        },
      },
      required: ["playId"],
    },
  },
  {
    name: "getPlayDetails",
    description:
      "Returns metadata for a single play: tier, position, target_base, runners_on, " +
      "credit_chain, hasVideo (boolean), fetch_status, teams, inning, half_inning, outs. " +
      "Use this to verify a play's classification or context before describing it in a finding. " +
      "The video URL itself is not returned (only a boolean).",
    input_schema: {
      type: "object",
      properties: {
        playId: {
          type: "number",
          description: "The plays.id value.",
        },
      },
      required: ["playId"],
    },
  },
  {
    name: "getHistoricalFindingOutcomes",
    description:
      "Aggregates confirmed/rejected/pending/ignored counts for past findings whose " +
      "suspected_rule_area matches the argument, scoped to the past N weeks. Use this " +
      "before claiming a pattern is recurring or has been confirmed before.",
    input_schema: {
      type: "object",
      properties: {
        suspectedRuleArea: {
          type: "string",
          description: "Rule area string from the allow-list (e.g. 'ranking.ts:target_base_scores').",
        },
        weeks: {
          type: "number",
          description: "Window size in weeks (e.g. 8 for the last two months).",
        },
      },
      required: ["suspectedRuleArea", "weeks"],
    },
  },
  {
    name: "getThreadMessageCount",
    description:
      "Returns the count of recorded play replies for a game thread. This is a lower-bound " +
      "approximation of channel engagement — based on slack_play_messages row count rather " +
      "than a live conversations.replies call. Use this before claiming a game generated " +
      "high or low channel discussion.",
    input_schema: {
      type: "object",
      properties: {
        gamePk: {
          type: "number",
          description: "The MLB game_pk identifier.",
        },
      },
      required: ["gamePk"],
    },
  },
  {
    name: "getPriorFindingDescription",
    description:
      "Returns the full row for a prior finding (id, run_id, week_starting, finding_type, " +
      "description, severity, evidence_strength, suspected_rule_area, outcome). Use this when " +
      "you see a prior finding listed in the user prompt and want to read its full description " +
      "for comparison. Descriptions older than 12 weeks may be null (retention sweep).",
    input_schema: {
      type: "object",
      properties: {
        findingId: {
          type: "number",
          description: "The agent_findings.id value.",
        },
      },
      required: ["findingId"],
    },
  },
  {
    name: "queryPlaysInWindow",
    description:
      "Filtered query for plays inside a Sunday-Saturday window. weekStarting and weekEnding " +
      "are required (YYYY-MM-DD). Optional filters (position, targetBase, runnersOn, tier, " +
      "hasVideo) are AND-combined. Returns up to 200 plays as PlayDetailsLite shapes. Use this " +
      "to confirm a pattern's scope (\"how many RF->Home throws this week?\") before asserting it.",
    input_schema: {
      type: "object",
      properties: {
        weekStarting: { type: "string", description: "YYYY-MM-DD Sunday." },
        weekEnding: { type: "string", description: "YYYY-MM-DD Saturday." },
        position: { type: "string", description: "Optional: LF / CF / RF." },
        targetBase: { type: "string", description: "Optional: 2B / 3B / Home." },
        runnersOn: { type: "string", description: "Optional: runners-on string match." },
        tier: { type: "string", description: "Optional: high / medium / low." },
        hasVideo: { type: "boolean", description: "Optional: true filters to plays with video; false to plays without." },
      },
      required: ["weekStarting", "weekEnding"],
    },
  },
  {
    name: "getPlayTagsForPlay",
    description:
      "Returns the phase 3 regex tags attached to a play (tier_dispute or video_issue). " +
      "Each tag has tagType and tagValue only — the original matched text is never returned. " +
      "Use this to confirm whether the channel flagged a play before describing channel " +
      "feedback as a pattern.",
    input_schema: {
      type: "object",
      properties: {
        playId: {
          type: "number",
          description: "The plays.id value.",
        },
      },
      required: ["playId"],
    },
  },
];

export const TOOL_NAMES = WEEKLY_REVIEW_TOOLS.map((t) => t.name);
export type ToolName = (typeof TOOL_NAMES)[number];
