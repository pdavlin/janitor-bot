/**
 * Anthropic Messages call wrapper.
 *
 * One call per run, with a single retry on transient failure (network,
 * 429, 5xx, or our own timeout). Each attempt is wrapped in a 50s hard
 * timeout so a hung TLS connection can't squat on the per-week lock —
 * worst-case wall clock is ~105s (50s + 5s backoff + 50s retry), well
 * under stale-lock recovery's 1h.
 *
 * Cost telemetry comes from the API response's `usage` block. Pricing
 * constants are model-specific and operator-internal (used for the
 * post-call "$1 spent" warn, not billing).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../../logger";
import type { BuiltPrompt } from "./prompt";

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
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Per-model pricing in USD per million tokens.
 *
 * Source: Anthropic public pricing page. Update when Anthropic ships
 * price changes or new models; this is operator-internal telemetry,
 * not billing. Unknown models fall back to `DEFAULT_PRICING` at the
 * Sonnet rate.
 */
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

export interface AgentClient {
  /**
   * Mirrors `Anthropic.Messages#create`. Provided as a parameter so
   * tests can substitute a mock without spinning the real SDK.
   */
  create(input: {
    model: string;
    max_tokens: number;
    system: string;
    messages: { role: "user"; content: string }[];
    temperature: number;
  }): Promise<{
    content: { type: string; text?: string }[];
    usage: { input_tokens: number; output_tokens: number };
  }>;
}

function defaultClient(apiKey: string): AgentClient {
  const sdk = new Anthropic({ apiKey });
  return {
    async create(input) {
      const response = await sdk.messages.create(input);
      return response as unknown as Awaited<ReturnType<AgentClient["create"]>>;
    },
  };
}

/** Calls the LLM with one retry on transient failure. */
export async function callAgent(
  apiKey: string,
  model: string,
  prompt: BuiltPrompt,
  logger: Logger,
  clientOverride?: AgentClient,
): Promise<AgentResult> {
  const client = clientOverride ?? defaultClient(apiKey);

  if (prompt.estimatedInputTokens > PRE_CALL_TOKEN_WARN) {
    logger.warn("agent prompt is large", {
      tokens: prompt.estimatedInputTokens,
    });
  }

  const attempt = async () =>
    Promise.race([
      client.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        temperature: 0,
      }),
      Bun.sleep(ATTEMPT_TIMEOUT_MS).then(() => {
        throw new AgentTimeoutError(
          `Anthropic call exceeded ${ATTEMPT_TIMEOUT_MS}ms`,
        );
      }),
    ]);

  let response;
  try {
    response = await attempt();
  } catch (err) {
    if (!isTransient(err)) throw err;
    logger.warn("agent call failed, retrying once", {
      error: err instanceof Error ? err.message : String(err),
    });
    await Bun.sleep(RETRY_DELAY_MS);
    response = await attempt();
  }

  const text = extractTextBlock(response);
  let parsed: { findings?: unknown[] };
  try {
    parsed = JSON.parse(text) as { findings?: unknown[] };
  } catch (err) {
    throw new AgentResponseError(
      `agent returned non-JSON content: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const cost = estimateCost(model, response.usage.input_tokens, response.usage.output_tokens);
  if (cost > POST_CALL_COST_WARN_USD) {
    logger.warn("agent run exceeded cost ceiling", {
      estimatedCostUsd: cost,
    });
  }

  return {
    rawFindings,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    estimatedCostUsd: cost,
  };
}

function extractTextBlock(response: {
  content: { type: string; text?: string }[];
}): string {
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
