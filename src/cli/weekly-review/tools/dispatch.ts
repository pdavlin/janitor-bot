/**
 * Routes a single `tool_use` block to its implementation.
 *
 * The dispatcher is the trust boundary: every tool call funnels
 * through here so a thrown error becomes a structured `internal_error`
 * result rather than crashing the agent loop. The agent then decides
 * how to react.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../../../logger";
import type { Tier } from "../../../types/play";
import { getVoteSnapshot } from "./get-vote-snapshot";
import { getPlayDetails } from "./get-play-details";
import { getHistoricalFindingOutcomes } from "./get-historical-finding-outcomes";
import { getThreadMessageCount } from "./get-thread-message-count";
import { getPriorFindingDescription } from "./get-prior-finding-description";
import { queryPlaysInWindow } from "./query-plays-in-window";
import { getPlayTagsForPlay } from "./get-play-tags-for-play";

export interface ToolContext {
  db: Database;
  logger: Logger;
}

export interface ToolError {
  error: string;
  message?: string;
}

/**
 * Anything JSON-serializable that `JSON.stringify` will turn into a
 * `tool_result` content payload. Tool implementations return their own
 * typed shapes; the dispatcher widens here so the caller doesn't have
 * to know which tool ran.
 */
export type ToolResult = object | ToolError;

function asNumber(value: unknown, field: string): number | ToolError {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return { error: "bad_input", message: `${field} must be a number` };
  }
  return n;
}

function asString(value: unknown, field: string): string | ToolError {
  if (typeof value !== "string" || value.length === 0) {
    return { error: "bad_input", message: `${field} must be a non-empty string` };
  }
  return value;
}

function isError(v: unknown): v is ToolError {
  return typeof v === "object" && v !== null && "error" in v;
}

export function dispatchToolCall(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): ToolResult {
  try {
    switch (name) {
      case "getVoteSnapshot": {
        const playId = asNumber(input.playId, "playId");
        if (isError(playId)) return playId;
        return getVoteSnapshot(ctx.db, playId);
      }
      case "getPlayDetails": {
        const playId = asNumber(input.playId, "playId");
        if (isError(playId)) return playId;
        return getPlayDetails(ctx.db, playId);
      }
      case "getHistoricalFindingOutcomes": {
        const area = asString(input.suspectedRuleArea, "suspectedRuleArea");
        if (isError(area)) return area;
        const weeks = asNumber(input.weeks, "weeks");
        if (isError(weeks)) return weeks;
        return getHistoricalFindingOutcomes(ctx.db, area, weeks);
      }
      case "getThreadMessageCount": {
        const gamePk = asNumber(input.gamePk, "gamePk");
        if (isError(gamePk)) return gamePk;
        return getThreadMessageCount(ctx.db, gamePk);
      }
      case "getPriorFindingDescription": {
        const findingId = asNumber(input.findingId, "findingId");
        if (isError(findingId)) return findingId;
        return getPriorFindingDescription(ctx.db, findingId);
      }
      case "queryPlaysInWindow": {
        const weekStarting = asString(input.weekStarting, "weekStarting");
        if (isError(weekStarting)) return weekStarting;
        const weekEnding = asString(input.weekEnding, "weekEnding");
        if (isError(weekEnding)) return weekEnding;
        return queryPlaysInWindow(ctx.db, {
          weekStarting,
          weekEnding,
          position: typeof input.position === "string" ? input.position : undefined,
          targetBase: typeof input.targetBase === "string" ? input.targetBase : undefined,
          runnersOn: typeof input.runnersOn === "string" ? input.runnersOn : undefined,
          tier: typeof input.tier === "string" ? (input.tier as Tier) : undefined,
          hasVideo:
            typeof input.hasVideo === "boolean" ? input.hasVideo : undefined,
        });
      }
      case "getPlayTagsForPlay": {
        const playId = asNumber(input.playId, "playId");
        if (isError(playId)) return playId;
        return getPlayTagsForPlay(ctx.db, playId);
      }
      default:
        return { error: "unknown_tool", message: name };
    }
  } catch (err) {
    ctx.logger.warn("tool call threw", {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
