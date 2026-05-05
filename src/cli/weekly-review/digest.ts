/**
 * Slack digest formatter.
 *
 * One mrkdwn message string per run. The baseline always leads (ground
 * truth), the LLM section follows (interpretation), and a hit-rate
 * footer closes. Findings are sorted strictly by severity ->
 * evidence_strength -> evidence count, and each description is
 * truncated to 280 chars in the post (the DB row keeps the full text).
 *
 * Three fallback shapes are supported:
 *   - insufficient: skipped LLM call due to minimum-signal gate
 *   - empty: LLM returned no findings
 *   - all-rejected: every finding failed validation
 */

import type { Logger } from "../../logger";
import {
  callSlackApi,
  type SlackClientConfig,
} from "../../notifications/slack-client";
import { renderBaselineForSlack, type Baseline } from "./baseline";
import type { Finding, HitRate } from "./types";
import type { WeekWindow } from "./week-window";

const FINDING_DESCRIPTION_LIMIT = 280;
const HIT_RATE_FLOOR = 5;

interface DigestInput {
  window: WeekWindow;
  baseline: Baseline;
  findings: readonly Finding[];
  hitRate: HitRate;
  runId: number;
}

/** Strict ordering: severity desc, evidence_strength desc, play count desc. */
const SEVERITY_RANK = { act: 0, watch: 1, info: 2 } as const;
const STRENGTH_RANK = { strong: 0, moderate: 1, weak: 2 } as const;

export function compareFindings(a: Finding, b: Finding): number {
  if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  }
  if (
    STRENGTH_RANK[a.evidence_strength] !== STRENGTH_RANK[b.evidence_strength]
  ) {
    return (
      STRENGTH_RANK[a.evidence_strength] - STRENGTH_RANK[b.evidence_strength]
    );
  }
  return b.evidence_play_ids.length - a.evidence_play_ids.length;
}

export function orderFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}

/**
 * Drops findings below `minStrength`. Default `weak` keeps everything;
 * called from the CLI's `--min-strength` flag handling.
 */
export function byMinStrength(
  minStrength: "weak" | "moderate" | "strong" = "weak",
): (f: Finding) => boolean {
  const threshold = STRENGTH_RANK[minStrength];
  return (f) => STRENGTH_RANK[f.evidence_strength] <= threshold;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.substring(0, max - 1) + "…";
}

function formatHitRate(h: HitRate): string {
  if (h.total < HIT_RATE_FLOOR) {
    return `hit rate: insufficient data (${h.total} resolved so far) — resolve findings via --resolve`;
  }
  return `hit rate over last 8 weeks: ${h.confirmed}/${h.total} findings confirmed`;
}

function formatHeader(window: WeekWindow): string {
  return `*Weekly classification review — week of ${window.weekStarting} to ${window.weekEnding}*`;
}

function formatFindingLine(f: Finding): string {
  const desc = truncate(f.description, FINDING_DESCRIPTION_LIMIT);
  const playCount = f.evidence_play_ids.length;
  return `• [${f.severity}, ${f.evidence_strength}] ${desc} — area: ${f.suspected_rule_area} — ${playCount} plays`;
}

/** Full digest with findings. */
export function buildDigest(input: DigestInput): string {
  const baselineText = renderBaselineForSlack(input.baseline);
  const findingLines = input.findings.map(formatFindingLine);
  const summary =
    `Summary: ${input.baseline.totalPlays} plays · ${input.baseline.playsWithVotes} with votes · ` +
    `${input.baseline.flaggedCount} flagged · ${formatHitRate(input.hitRate)}`;

  return [
    formatHeader(input.window),
    "",
    summary,
    "",
    baselineText,
    "",
    `Findings (${input.findings.length}):`,
    ...findingLines,
    "",
    `Resolve with: bun run weekly-review --resolve ${input.runId} {finding_id} {confirmed|rejected}`,
  ].join("\n");
}

/** Skipped LLM (minimum-signal gate). */
export function buildInsufficientDigest(
  window: WeekWindow,
  plays: number,
  votes: number,
): string {
  return [
    formatHeader(window),
    "",
    `Insufficient data this week — ${plays} plays, ${votes} votes.`,
  ].join("\n");
}

/** LLM ran but returned zero findings (or every one filtered by --min-strength). */
export function buildEmptyDigest(
  window: WeekWindow,
  baseline: Baseline,
  hitRate: HitRate,
): string {
  return [
    formatHeader(window),
    "",
    `Summary: ${baseline.totalPlays} plays · ${baseline.playsWithVotes} with votes · ${baseline.flaggedCount} flagged · ${formatHitRate(hitRate)}`,
    "",
    renderBaselineForSlack(baseline),
    "",
    "No systematic patterns detected this week.",
  ].join("\n");
}

/** All findings failed validation (description rules). */
export function buildAllRejectedDigest(
  window: WeekWindow,
  baseline: Baseline,
  hitRate: HitRate,
  rejectedCount: number,
): string {
  return [
    formatHeader(window),
    "",
    `Summary: ${baseline.totalPlays} plays · ${baseline.playsWithVotes} with votes · ${baseline.flaggedCount} flagged · ${formatHitRate(hitRate)}`,
    "",
    renderBaselineForSlack(baseline),
    "",
    `LLM findings withheld this week — ${rejectedCount} findings failed output validation.`,
  ].join("\n");
}

/** Stats-only mode digest (baseline only, no LLM). */
export function buildStatsOnlyDigest(
  window: WeekWindow,
  baseline: Baseline,
): string {
  return [
    `*Weekly classification review (stats-only) — week of ${window.weekStarting} to ${window.weekEnding}*`,
    "",
    renderBaselineForSlack(baseline),
  ].join("\n");
}

/** Posts the digest to the configured channel via `chat.postMessage`. */
export async function postDigest(
  config: SlackClientConfig,
  channel: string,
  message: string,
  logger: Logger,
): Promise<{ ts: string } | null> {
  if (!config.botToken) {
    logger.debug("postDigest skipped: no bot token");
    return null;
  }
  const result = await callSlackApi<{ ok: true; ts: string }>(
    "chat.postMessage",
    { channel, text: message },
    config.botToken,
    logger,
  );
  if (!result) return null;
  return { ts: result.ts };
}
