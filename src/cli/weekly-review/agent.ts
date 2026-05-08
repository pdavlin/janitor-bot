/**
 * Anthropic Messages call wrapper with tool-use loop.
 *
 * The single-call shape is preserved when `options.tools` and
 * `options.toolContext` are not supplied: one round trip, parse the
 * text block, return. With tools enabled, the loop repeatedly dispatches
 * `tool_use` blocks via the registered dispatcher and feeds back
 * `tool_result` blocks until the model emits a final response without
 * any tool_use blocks (or until safety nets trip).
 *
 * Each round trip is wrapped in a 50s hard timeout and supports a
 * single transient-failure retry — same per-attempt behavior as before.
 *
 * Cost telemetry comes from each round trip's `usage` block; running
 * cost is checked BEFORE each tool dispatch. Once the cost cap trips,
 * pending tool requests in the same response receive
 * `{ error: "cost_cap_reached" }` and the next call (if any) is the
 * loop's last.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { Logger } from "../../logger";
import type { BuiltPrompt } from "./prompt";
import { dispatchToolCall, type ToolContext } from "./tools/dispatch";

export class AgentTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTimeoutError";
  }
}

export class AgentResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentResponseError";
  }
}

export interface AgentResult {
  /** Raw findings array from the parsed response. Validation is downstream. */
  rawFindings: unknown[];
  /** Original final response text before fence-stripping. Useful for dumps. */
  rawText: string;
  /** Input tokens from the FINAL round trip only (used for telemetry display). */
  inputTokens: number;
  /** Output tokens from the FINAL round trip only. */
  outputTokens: number;
  /** Sum of estimated cost across every round trip in this run. */
  estimatedCostUsd: number;
  /** Total tool calls dispatched across the whole conversation. */
  toolCallCount: number;
  /** Per-tool dispatch counts, e.g. { getVoteSnapshot: 3 }. */
  toolCallBreakdown: Record<string, number>;
}

interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-7": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
};

const DEFAULT_PRICING: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 };

const ATTEMPT_TIMEOUT_MS = 50_000;
const RETRY_DELAY_MS = 5_000;
const PRE_CALL_TOKEN_WARN = 100_000;
const POST_CALL_COST_WARN_USD = 1;
const MAX_OUTPUT_TOKENS = 4096;
const COST_CAP_USD = 0.5;
const MAX_ROUND_TRIPS = 20;

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [k: string]: unknown;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface AgentClient {
  /**
   * Mirrors `Anthropic.Messages#create`. Provided as a parameter so
   * tests can substitute a mock without spinning the real SDK.
   *
   * Content blocks may be `text`, `tool_use`, or anything else the
   * model emits; the loop only interprets `text` and `tool_use`.
   */
  create(input: {
    model: string;
    max_tokens: number;
    system: string;
    messages: AgentMessage[];
    temperature: number;
    tools?: Tool[];
  }): Promise<{
    content: ContentBlock[];
    usage: { input_tokens: number; output_tokens: number };
    stop_reason?: string;
  }>;
}

function defaultClient(apiKey: string): AgentClient {
  const sdk = new Anthropic({ apiKey });
  return {
    async create(input) {
      // The SDK types `messages` and `content` strictly per-block; our
      // wrapper widens to a structural ContentBlock that holds tool_use,
      // tool_result, and text uniformly. Runtime shapes are compatible —
      // we forward the model's content array unmodified back to the SDK.
      const response = await sdk.messages.create(
        input as unknown as Parameters<typeof sdk.messages.create>[0],
      );
      return response as unknown as Awaited<ReturnType<AgentClient["create"]>>;
    },
  };
}

export interface CallAgentOptions {
  /** Tool registry passed to the API. Without it the agent runs single-turn. */
  tools?: Tool[];
  /** Context for `dispatchToolCall`. Required when `tools` is set. */
  toolContext?: ToolContext;
}

/**
 * Calls the LLM, dispatching tool_use blocks until the model emits a
 * final response. Each round trip retries once on transient failure.
 */
export async function callAgent(
  apiKey: string,
  model: string,
  prompt: BuiltPrompt,
  logger: Logger,
  clientOverride?: AgentClient,
  options?: CallAgentOptions,
): Promise<AgentResult> {
  const client = clientOverride ?? defaultClient(apiKey);

  if (prompt.estimatedInputTokens > PRE_CALL_TOKEN_WARN) {
    logger.warn("agent prompt is large", {
      tokens: prompt.estimatedInputTokens,
    });
  }

  const tools = options?.tools;
  const toolContext = options?.toolContext;
  const toolsEnabled = Boolean(tools && tools.length > 0 && toolContext);

  const messages: AgentMessage[] = [{ role: "user", content: prompt.user }];
  const toolCallBreakdown: Record<string, number> = {};
  let toolCallCount = 0;
  let totalCost = 0;
  let lastInputTokens = 0;
  let lastOutputTokens = 0;
  let lastResponse: Awaited<ReturnType<AgentClient["create"]>> | null = null;

  const attempt = async () =>
    Promise.race([
      client.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: prompt.system,
        messages,
        temperature: 0,
        ...(toolsEnabled ? { tools } : {}),
      }),
      Bun.sleep(ATTEMPT_TIMEOUT_MS).then(() => {
        throw new AgentTimeoutError(
          `Anthropic call exceeded ${ATTEMPT_TIMEOUT_MS}ms`,
        );
      }),
    ]);

  for (let round = 0; round < MAX_ROUND_TRIPS; round++) {
    let response: Awaited<ReturnType<AgentClient["create"]>>;
    try {
      response = await attempt();
    } catch (err) {
      if (!isTransient(err)) throw err;
      logger.warn("agent call failed, retrying once", {
        error: err instanceof Error ? err.message : String(err),
        round,
      });
      await Bun.sleep(RETRY_DELAY_MS);
      response = await attempt();
    }

    lastResponse = response;
    lastInputTokens = response.usage.input_tokens;
    lastOutputTokens = response.usage.output_tokens;
    totalCost += estimateCost(
      model,
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    const toolUseBlocks = response.content.filter(
      (b): b is ContentBlock & { type: "tool_use"; id: string; name: string; input: unknown } =>
        b.type === "tool_use" &&
        typeof b.id === "string" &&
        typeof b.name === "string",
    );

    if (toolUseBlocks.length === 0 || !toolsEnabled) {
      if (totalCost > POST_CALL_COST_WARN_USD) {
        logger.warn("agent run exceeded cost ceiling", {
          estimatedCostUsd: totalCost,
        });
      }
      return finalize(response, totalCost, toolCallCount, toolCallBreakdown, {
        inputTokens: lastInputTokens,
        outputTokens: lastOutputTokens,
      });
    }

    messages.push({ role: "assistant", content: response.content });

    const resultBlocks: ContentBlock[] = toolUseBlocks.map((block) => {
      if (totalCost >= COST_CAP_USD) {
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({
            error: "cost_cap_reached",
            call_count: toolCallCount,
          }),
        };
      }
      const input = (block.input ?? {}) as Record<string, unknown>;
      const result = dispatchToolCall(block.name, input, toolContext!);
      toolCallCount++;
      toolCallBreakdown[block.name] = (toolCallBreakdown[block.name] ?? 0) + 1;
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      };
    });

    messages.push({ role: "user", content: resultBlocks });
  }

  logger.warn("tool-use loop hit MAX_ROUND_TRIPS; treating last response as final", {
    maxRoundTrips: MAX_ROUND_TRIPS,
    toolCallCount,
  });
  if (!lastResponse) {
    throw new AgentResponseError(
      "tool-use loop terminated without any response",
    );
  }
  return finalize(lastResponse, totalCost, toolCallCount, toolCallBreakdown, {
    inputTokens: lastInputTokens,
    outputTokens: lastOutputTokens,
  });
}

function finalize(
  response: Awaited<ReturnType<AgentClient["create"]>>,
  totalCost: number,
  toolCallCount: number,
  toolCallBreakdown: Record<string, number>,
  tokens: { inputTokens: number; outputTokens: number },
): AgentResult {
  const text = extractTextBlock(response);
  const json = extractJsonPayload(text);
  let parsed: { findings?: unknown[] };
  try {
    parsed = JSON.parse(json) as { findings?: unknown[] };
  } catch (err) {
    throw new AgentResponseError(
      `agent returned non-JSON content: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  return {
    rawFindings,
    rawText: text,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    estimatedCostUsd: totalCost,
    toolCallCount,
    toolCallBreakdown,
  };
}

/**
 * Strips the model's response down to the bare JSON payload.
 *
 * Even with explicit "output strict JSON" instructions, models often
 * wrap output in a ```json ... ``` markdown fence for readability.
 * This helper:
 *   1. Returns the inside of a fenced block when one exists.
 *   2. Otherwise extracts from the first `{` to the last `}` so prose
 *      before/after the object (rare but possible) doesn't break parsing.
 *   3. Falls back to the raw, trimmed text.
 *
 * Exported for unit tests; the runtime call path goes through
 * `callAgent`.
 */
export function extractJsonPayload(text: string): string {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence && fence[1]) return fence[1].trim();

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return text.substring(first, last + 1);
  }

  return text.trim();
}

function extractTextBlock(response: { content: ContentBlock[] }): string {
  const block = response.content.find(
    (c) => c.type === "text" && typeof c.text === "string" && c.text.length > 0,
  );
  if (!block || !block.text) {
    throw new AgentResponseError(
      "agent response had no text content block",
    );
  }
  return block.text;
}

/**
 * Returns true for errors safe to retry: timeouts, network errors,
 * 429, and 5xx. Auth and 4xx errors are NOT retried.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof AgentTimeoutError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (typeof status === "number" && status >= 500) return true;
    return false;
  }
  if (err instanceof Error && err.message.toLowerCase().includes("network")) {
    return true;
  }
  return false;
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING[model] ?? DEFAULT_PRICING;
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}
