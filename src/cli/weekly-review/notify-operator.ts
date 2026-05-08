/**
 * Operator-DM helper for the weekly-review CLI.
 *
 * Sends a single Slack DM to a configured operator user_id when one
 * of four trigger events fires on prod:
 *   - dump_captured           — a `--dump` JSON record was written
 *   - concurrent_run_blocked  — a second invocation hit the per-week lock
 *   - retention_sweep_failed  — the post-run sweep threw
 *   - all_findings_rejected   — every LLM finding failed validation
 *
 * Best-effort delivery: any failure (missing user_id, missing bot
 * token, Slack non-ok, network throw) is swallowed and logged at warn.
 * The helper never throws and never affects the underlying run's exit
 * code, lock state, or DB writes.
 *
 * Slack accepts `chat.postMessage` with `channel = userId` and opens
 * the IM implicitly. The existing `chat:write` scope covers it.
 *
 * Body builders are pure-string constructions over structured context
 * inputs. There is no path from a `Transcript` to a body line, which
 * is why the leakage-check regex does not require an allow marker on
 * this file.
 */

import type { Logger } from "../../logger";
import {
  callSlackApi,
  type SlackClientConfig,
} from "../../notifications/slack-client";

export type NotificationKind =
  | "dump_captured"
  | "concurrent_run_blocked"
  | "retention_sweep_failed"
  | "all_findings_rejected";

const KIND_PREFIX: Record<NotificationKind, string> = {
  dump_captured: ":floppy_disk: Weekly-review dump captured",
  concurrent_run_blocked: ":lock: Concurrent weekly-review blocked",
  retention_sweep_failed: ":warning: Retention sweep failed",
  all_findings_rejected: ":no_entry_sign: All LLM findings rejected",
};

export interface DumpCapturedContext {
  weekStarting: string;
  weekEnding: string;
  runId: number;
  model: string;
  dumpPath: string;
  acceptedCount: number;
  rejectedCount: number;
  estimatedCostUsd: number;
}

export interface ConcurrentRunBlockedContext {
  weekStarting: string;
  /** Run id of the in-progress `started` row, when known. */
  blockingRunId: number | null;
}

export interface RetentionSweepFailedContext {
  runId: number;
  errorMessage: string;
}

export interface AllFindingsRejectedContext {
  runId: number;
  weekStarting: string;
  /** Counts grouped by short reason key (`quote`, `mention`, etc.). */
  rejectionsByReason: Record<string, number>;
  totalRejected: number;
}

export type NotificationBody =
  | { kind: "dump_captured"; ctx: DumpCapturedContext }
  | { kind: "concurrent_run_blocked"; ctx: ConcurrentRunBlockedContext }
  | { kind: "retention_sweep_failed"; ctx: RetentionSweepFailedContext }
  | { kind: "all_findings_rejected"; ctx: AllFindingsRejectedContext };

const ERROR_MESSAGE_TRUNCATE = 280;

/** Renders a `NotificationBody` to the final mrkdwn text Slack receives. */
export function renderNotification(body: NotificationBody): string {
  const prefix = KIND_PREFIX[body.kind];
  const lines = bodyLines(body);
  return [prefix, "", ...lines].join("\n");
}

function bodyLines(body: NotificationBody): string[] {
  switch (body.kind) {
    case "dump_captured": {
      const c = body.ctx;
      return [
        `Week: ${c.weekStarting} to ${c.weekEnding}`,
        `Run id: ${c.runId} (model: ${c.model})`,
        `Findings: ${c.acceptedCount} accepted, ${c.rejectedCount} rejected`,
        `Cost: $${c.estimatedCostUsd.toFixed(4)}`,
        `Dump: ${c.dumpPath}`,
      ];
    }
    case "concurrent_run_blocked": {
      const c = body.ctx;
      const idLine =
        c.blockingRunId !== null
          ? `Blocked by run id ${c.blockingRunId}.`
          : `Blocked by an in-progress run.`;
      return [
        `Week: ${c.weekStarting}`,
        idLine,
        "Recover with `bun run weekly-review --force-clear-stale-lock --week-starting <date>` if the prior run is genuinely stuck (>1h old).",
      ];
    }
    case "retention_sweep_failed": {
      const c = body.ctx;
      const truncated =
        c.errorMessage.length > ERROR_MESSAGE_TRUNCATE
          ? `${c.errorMessage.substring(0, ERROR_MESSAGE_TRUNCATE - 1)}…`
          : c.errorMessage;
      return [
        `Run id: ${c.runId}`,
        `The weekly digest posted successfully; the post-run sweep threw.`,
        `Error: ${truncated}`,
        `Manual recovery: re-run the sweep SQL or wait for the next weekly run.`,
      ];
    }
    case "all_findings_rejected": {
      const c = body.ctx;
      const reasons = Object.entries(c.rejectionsByReason)
        .map(([reason, count]) => `${reason}: ${count}`)
        .sort()
        .join(", ");
      return [
        `Week: ${c.weekStarting}`,
        `Run id: ${c.runId}`,
        `${c.totalRejected} LLM findings failed validation; the digest fell back to baseline-only.`,
        `By reason: ${reasons}`,
        "Likely a prompt-iteration signal. Inspect via `bun run weekly-review --show-last` or replay the dump.",
      ];
    }
  }
}

/**
 * Sends a Slack DM to the configured operator. Best-effort:
 * returns false (and logs warn at the call site or here) on any
 * failure. Returns false silently when `userId` or `botToken` is
 * absent so callers can pass `config.operatorUserId` directly without
 * gating.
 */
export async function notifyOperator(
  slackConfig: SlackClientConfig,
  userId: string | undefined,
  body: NotificationBody,
  logger: Logger,
): Promise<boolean> {
  if (!userId) return false;
  if (!slackConfig.botToken) return false;

  const text = renderNotification(body);
  try {
    const result = await callSlackApi<{ ok: true; ts: string }>(
      "chat.postMessage",
      { channel: userId, text },
      slackConfig.botToken,
      logger,
    );
    if (!result) {
      logger.warn("operator DM not sent (Slack returned non-ok)", {
        kind: body.kind,
      });
      return false;
    }
    logger.debug("operator DM sent", { kind: body.kind, ts: result.ts });
    return true;
  } catch (err) {
    logger.warn("operator DM threw", {
      kind: body.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
