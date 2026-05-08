/**
 * Branded types and shared shapes for the weekly-review CLI.
 *
 * The `Transcript` brand is the load-bearing piece: persistence and
 * logging APIs accept narrower types (`AgentRunRow`, `FindingRow`) that
 * do NOT include `Transcript`, so passing transcript content into a
 * DB write or logger call is a TypeScript error. The CI grep in
 * `scripts/check-no-transcript-leakage.ts` is defense-in-depth for
 * the cases the brand can't catch (`JSON.stringify` of a wrapper).
 */

export type Severity = "info" | "watch" | "act";
export type EvidenceStrength = "weak" | "moderate" | "strong";
export type Trend = "first_seen" | "recurring" | "escalating" | "cooling";
export type Outcome = "pending" | "confirmed" | "rejected" | "ignored";
export type RunStatus = "started" | "success" | "error";

declare const TranscriptBrand: unique symbol;

/**
 * In-memory bundle of channel discussion for a single run.
 *
 * The `[TranscriptBrand]` tag makes structurally-similar plain objects
 * incompatible at the type level. Construct only via `buildTranscript`.
 */
export interface Transcript {
  readonly [TranscriptBrand]: never;
  readonly games: readonly TranscriptGame[];
}

export interface TranscriptGame {
  readonly gamePk: number;
  /** Slack `ts` of the parent header message for this game. */
  readonly headerTs: string;
  /** True when older messages were dropped to fit the 2k-token cap. */
  readonly truncated: boolean;
  readonly messages: readonly TranscriptMessage[];
}

export interface TranscriptMessage {
  readonly text: string;
  readonly user: string;
  readonly ts: string;
}

/**
 * The only constructor for a `Transcript`. The brand exists purely at
 * the type level (`TranscriptBrand` is `declare const`), so the cast is
 * intentional: the runtime value is just `{ games }`, but the
 * compile-time tag prevents structural lookalikes from being passed
 * into APIs that accept `Transcript`.
 */
export function buildTranscript(games: readonly TranscriptGame[]): Transcript {
  return { games } as unknown as Transcript;
}

/**
 * Validated finding ready for persistence and Slack rendering. Distinct
 * from the raw shape returned by the LLM (which is `unknown` until
 * validated).
 */
export interface Finding {
  finding_type: string;
  description: string;
  severity: Severity;
  evidence_strength: EvidenceStrength;
  evidence_play_ids: number[];
  suspected_rule_area: string;
  trend: Trend | null;
}

/**
 * Row shape for `agent_findings`. Matches the SQL columns 1:1; consumers
 * never see a `Transcript` here.
 */
export interface FindingRow {
  id: number;
  run_id: number;
  finding_type: string;
  description: string | null;
  severity: Severity;
  evidence_strength: EvidenceStrength;
  evidence_play_ids: string;
  suspected_rule_area: string;
  trend: Trend | null;
  outcome: Outcome;
  resolved_at: string | null;
  resolved_by_run_id: number | null;
  created_at: string;
  /** week_starting from the joined agent_runs row, when present. */
  week_starting?: string;
}

/** Row shape for `agent_runs`. */
export interface AgentRunRow {
  id: number;
  week_starting: string;
  model: string;
  started_at: string;
  completed_at: string | null;
  status: RunStatus;
  error_text: string | null;
  posted_message_ts: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  tool_call_count: number | null;
  tool_call_breakdown: string | null;
}

/** Aggregate hit-rate computed by `findings-store.getHitRate`. */
export interface HitRate {
  confirmed: number;
  total: number;
}
