/**
 * Slack digest formatter.
 *
 * One mrkdwn message string per run. The baseline always leads (ground
 * truth), then a hit-rate footer closes. The full-run parent no longer
 * inlines findings — each accepted finding is posted as its own thread
 * reply (see post-finding-replies.ts), and duplicating the content in
 * the parent was just noise.
 *
 * Findings are still sorted by severity -> evidence_strength ->
 * evidence count by `orderFindings` so the threaded replies appear in
 * priority order.
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

const HIT_RATE_FLOOR = 5;

interface DigestInput {
  window: WeekWindow;
  baseline: Baseline;
  findings: readonly Finding[];
  hitRate: HitRate;
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

function formatHitRate(h: HitRate): string {
  if (h.total < HIT_RATE_FLOOR) {
    return `hit rate: insufficient data (${h.total} resolved so far) — resolve findings via --resolve`;
  }
  return `hit rate over last 8 weeks: ${h.confirmed}/${h.total} findings confirmed`;
}

function formatHeader(window: WeekWindow): string {
  return `*Weekly classification review — week of ${window.weekStarting} to ${window.weekEnding}*`;
}

/**
 * Parent message for a full run. Findings themselves are posted as
 * thread replies by `postFindingReplies`, so the parent stays
 * lightweight: header, summary, baseline. Resolution happens via
 * :white_check_mark:/:x: reactions on the thread replies; the CLI
 * `--resolve` path remains available as a manual fallback but isn't
 * advertised inline.
 */
export function buildDigest(input: DigestInput): string {
  const baselineText = renderBaselineForSlack(input.baseline);
  const summary =
    `Summary: ${input.baseline.totalPlays} plays · ${input.baseline.playsWithVotes} with votes · ` +
    `${input.baseline.flaggedCount} flagged · ${formatHitRate(input.hitRate)}`;

  return [
    formatHeader(input.window),
    "",
    summary,
    "",
    baselineText,
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
