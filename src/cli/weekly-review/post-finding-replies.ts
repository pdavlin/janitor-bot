/**
 * Per-finding thread reply poster.
 *
 * Invoked from runFull after the digest header is posted. For each ordered
 * finding it posts a thread reply under the digest header, seeds
 * :white_check_mark: / :x: reactions, and records the (run_id, finding_id) ->
 * ts mapping so the reaction handler can map an inbound reaction back to its
 * finding.
 *
 * Per-finding failures are isolated: a single Slack hiccup on finding[i]
 * does not block findings[i+1..]. The aggregated result lets the caller log
 * per-finding success/failure.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../../logger";
import {
  postThreadTextWithTs,
  seedConfirmRejectReactions,
  type SlackClientConfig,
} from "../../notifications/slack-client";
import { recordFindingMessage } from "../../notifications/slack-finding-messages-store";
import type { Finding } from "./types";

const FINDING_REPLY_DESCRIPTION_LIMIT = 280;

export interface FindingReplyResult {
  findingId: number;
  ok: boolean;
  ts: string | null;
}

export interface PostFindingRepliesParent {
  channel: string;
  ts: string;
  runId: number;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.substring(0, max - 1) + "…";
}

export function renderFindingForReply(f: Finding): string {
  const desc = truncate(f.description, FINDING_REPLY_DESCRIPTION_LIMIT);
  return [
    `[${f.severity}, ${f.evidence_strength}] ${desc}`,
    `Area: ${f.suspected_rule_area} · ${f.evidence_play_ids.length} plays`,
    `React :white_check_mark: to confirm or :x: to reject within 24h.`,
  ].join("\n");
}

/**
 * Posts each finding as a thread reply under the digest header. Iterates
 * sequentially: Slack's per-channel rate limits prefer serial posts, and the
 * sequence is short (typically <10 findings).
 */
export async function postFindingReplies(
  db: Database,
  config: SlackClientConfig,
  parent: PostFindingRepliesParent,
  findings: readonly Finding[],
  findingIds: readonly number[],
  logger: Logger,
): Promise<FindingReplyResult[]> {
  if (findings.length !== findingIds.length) {
    throw new Error(
      `findings.length (${findings.length}) must equal findingIds.length (${findingIds.length})`,
    );
  }

  const results: FindingReplyResult[] = [];
  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i]!;
    const findingId = findingIds[i]!;
    const text = renderFindingForReply(finding);
    try {
      const result = await postThreadTextWithTs(
        config,
        parent.channel,
        parent.ts,
        text,
        logger,
      );
      if (!result) {
        logger.warn("per-finding post returned no ts", { findingId });
        results.push({ findingId, ok: false, ts: null });
        continue;
      }
      recordFindingMessage(
        db,
        parent.runId,
        findingId,
        result.channel,
        result.ts,
        parent.ts,
      );
      await seedConfirmRejectReactions(config, result.channel, result.ts, logger);
      results.push({ findingId, ok: true, ts: result.ts });
    } catch (err) {
      logger.warn("per-finding post failed", {
        findingId,
        error: err instanceof Error ? err.message : String(err),
      });
      results.push({ findingId, ok: false, ts: null });
    }
  }
  return results;
}
