/**
 * Output validation for findings returned by the LLM.
 *
 * Three rejection rules per finding's `description`:
 *   1. Quote characters anywhere in the description.
 *   2. Slack mention syntax (`<@`, `<#`, `<!`).
 *   3. Any 30-char contiguous substring that also appears verbatim in a
 *      transcript message (description -> transcript direction).
 *
 * Findings that fail any rule are dropped with their `finding_type`
 * surfaced for logging; the description itself is never logged. An
 * invalid `suspected_rule_area` is normalized to "unknown" rather than
 * rejecting the whole finding (preserves analytic value, flags drift).
 */

import type { Logger } from "../../logger";
import type { Finding, Severity, EvidenceStrength, Trend, Transcript } from "./types";
import { normalizeRuleArea, RULE_AREAS } from "./rule-areas";

const QUOTE_CHARS = ["\"", "“", "”", "'", "‘", "’"];
const MENTION_TOKENS = ["<@", "<#", "<!"];
const SUBSTRING_WINDOW = 30;

const SEVERITIES: readonly Severity[] = ["info", "watch", "act"];
const STRENGTHS: readonly EvidenceStrength[] = ["weak", "moderate", "strong"];
const TRENDS: readonly Trend[] = [
  "first_seen",
  "recurring",
  "escalating",
  "cooling",
];

export interface RejectedFinding {
  finding_type: string;
  reason: string;
}

export interface ValidationResult {
  accepted: Finding[];
  rejected: RejectedFinding[];
}

/**
 * Filters raw LLM output into the subset that's safe to persist and
 * post. Each rejection records the structural label plus a short
 * reason; the description itself is never echoed.
 */
export function validateFindings(
  raw: unknown[],
  transcript: Transcript,
  logger: Logger,
): ValidationResult {
  const accepted: Finding[] = [];
  const rejected: RejectedFinding[] = [];

  for (const item of raw) {
    const shape = checkShape(item);
    if ("reason" in shape) {
      logger.warn("agent finding rejected at shape check", {
        reason: shape.reason,
      });
      rejected.push({
        finding_type: getFindingType(item) ?? "<unknown>",
        reason: shape.reason,
      });
      continue;
    }
    const candidate = shape.value;

    const descriptionReason = checkDescription(candidate.description, transcript);
    if (descriptionReason) {
      logger.warn("agent finding rejected at description check", {
        finding_type: candidate.finding_type,
        reason: descriptionReason,
      });
      rejected.push({
        finding_type: candidate.finding_type,
        reason: descriptionReason,
      });
      continue;
    }

    const ruleArea = normalizeRuleArea(candidate.suspected_rule_area, logger);
    accepted.push({ ...candidate, suspected_rule_area: ruleArea });
  }

  return { accepted, rejected };
}

function getFindingType(item: unknown): string | null {
  if (item && typeof item === "object" && "finding_type" in item) {
    const t = (item as { finding_type: unknown }).finding_type;
    if (typeof t === "string") return t;
  }
  return null;
}

type ShapeResult =
  | { value: Finding }
  | { reason: string };

function checkShape(item: unknown): ShapeResult {
  if (!item || typeof item !== "object") {
    return { reason: "not an object" };
  }
  const obj = item as Record<string, unknown>;

  if (typeof obj.finding_type !== "string" || obj.finding_type.length === 0) {
    return { reason: "missing finding_type" };
  }
  if (typeof obj.description !== "string" || obj.description.length === 0) {
    return { reason: "missing description" };
  }
  if (!SEVERITIES.includes(obj.severity as Severity)) {
    return { reason: "invalid severity" };
  }
  if (!STRENGTHS.includes(obj.evidence_strength as EvidenceStrength)) {
    return { reason: "invalid evidence_strength" };
  }
  if (!Array.isArray(obj.evidence_play_ids) || obj.evidence_play_ids.length === 0) {
    return { reason: "missing evidence_play_ids" };
  }
  for (const id of obj.evidence_play_ids) {
    if (typeof id !== "number" || !Number.isInteger(id)) {
      return { reason: "non-integer in evidence_play_ids" };
    }
  }
  if (typeof obj.suspected_rule_area !== "string") {
    return { reason: "missing suspected_rule_area" };
  }
  if (
    obj.trend !== null &&
    obj.trend !== undefined &&
    !TRENDS.includes(obj.trend as Trend)
  ) {
    return { reason: "invalid trend" };
  }

  return {
    value: {
      finding_type: obj.finding_type,
      description: obj.description,
      severity: obj.severity as Severity,
      evidence_strength: obj.evidence_strength as EvidenceStrength,
      evidence_play_ids: obj.evidence_play_ids as number[],
      suspected_rule_area: obj.suspected_rule_area,
      trend: (obj.trend ?? null) as Trend | null,
    },
  };
}

function checkDescription(description: string, transcript: Transcript): string | null {
  for (const ch of QUOTE_CHARS) {
    if (description.includes(ch)) return "description contains a quote character";
  }
  for (const tok of MENTION_TOKENS) {
    if (description.includes(tok)) {
      return "description contains a Slack mention token";
    }
  }
  if (description.length >= SUBSTRING_WINDOW) {
    for (let offset = 0; offset <= description.length - SUBSTRING_WINDOW; offset++) {
      const window = description.substring(offset, offset + SUBSTRING_WINDOW);
      if (transcriptIncludes(transcript, window)) {
        return "description matches a 30-char substring of a transcript message";
      }
    }
  }
  return null;
}

function transcriptIncludes(transcript: Transcript, needle: string): boolean {
  for (const game of transcript.games) {
    for (const message of game.messages) {
      if (message.text.includes(needle)) return true;
    }
  }
  return false;
}

/** Re-exported for callers that need the canonical ordering of rule areas. */
export { RULE_AREAS };
