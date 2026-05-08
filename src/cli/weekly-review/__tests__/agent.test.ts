import { test, expect, describe, beforeEach } from "bun:test";
import { createLogger } from "../../../logger";
import { callAgent, estimateCost, type AgentClient } from "../agent";
import type { BuiltPrompt } from "../prompt";

const silentLogger = createLogger("error");

const PROMPT: BuiltPrompt = {
  system: "system text",
  user: "user text",
  estimatedInputTokens: 1000,
};

interface FakeClientOpts {
  responses: Array<
    | { kind: "ok"; text: string; inputTokens?: number; outputTokens?: number }
    | { kind: "throw"; err: Error }
  >;
}

function makeClient(opts: FakeClientOpts): AgentClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async create() {
      const idx = calls;
      calls++;
      const next = opts.responses[idx];
      if (!next) throw new Error("unexpected extra call to agent client");
      if (next.kind === "throw") throw next.err;
      return {
        content: [{ type: "text", text: next.text }],
        usage: {
          input_tokens: next.inputTokens ?? 1000,
          output_tokens: next.outputTokens ?? 200,
        },
      };
    },
  } as AgentClient & { calls: number };
}

function transientNetworkError(): Error {
  return new Error("network connection refused");
}

describe("callAgent", () => {
  test("parses findings on a happy path", async () => {
    const client = makeClient({
      responses: [
        {
          kind: "ok",
          text: JSON.stringify({
            findings: [
              { finding_type: "rf_home_pushback", description: "x", severity: "watch" },
            ],
          }),
        },
      ],
    });
    const result = await callAgent(
      "k",
      "claude-sonnet-4-6",
      PROMPT,
      silentLogger,
      client,
    );
    expect(result.rawFindings).toHaveLength(1);
    expect(client.calls).toBe(1);
  });

  // The agent waits 5s before retrying; bump the per-test timeout so the
  // backoff can run inside a real suite invocation.
  test("retries once on a transient network error", async () => {
    const client = makeClient({
      responses: [
        { kind: "throw", err: transientNetworkError() },
        { kind: "ok", text: JSON.stringify({ findings: [] }) },
      ],
    });
    const result = await callAgent(
      "k",
      "claude-sonnet-4-6",
      PROMPT,
      silentLogger,
      client,
    );
    expect(result.rawFindings).toEqual([]);
    expect(client.calls).toBe(2);
  }, 10_000);

  test("does not retry on non-transient errors", async () => {
    const client = makeClient({
      responses: [{ kind: "throw", err: new Error("auth: invalid api key") }],
    });
    await expect(
      callAgent("k", "claude-sonnet-4-6", PROMPT, silentLogger, client),
    ).rejects.toThrow(/auth/);
    expect(client.calls).toBe(1);
  });

  test("throws when the response has no JSON findings array", async () => {
    const client = makeClient({
      responses: [{ kind: "ok", text: "not json" }],
    });
    await expect(
      callAgent("k", "claude-sonnet-4-6", PROMPT, silentLogger, client),
    ).rejects.toThrow(/non-JSON/);
  });

  test("computes cost from the usage block", async () => {
    const client = makeClient({
      responses: [
        {
          kind: "ok",
          text: JSON.stringify({ findings: [] }),
          inputTokens: 1_000_000,
          outputTokens: 100_000,
        },
      ],
    });
    const result = await callAgent(
      "k",
      "claude-sonnet-4-6",
      PROMPT,
      silentLogger,
      client,
    );
    // 1M input * $3 + 0.1M output * $15 = $3 + $1.5 = $4.50
    expect(result.estimatedCostUsd).toBeCloseTo(4.5, 4);
  });
});

describe("estimateCost", () => {
  test("uses model-specific pricing", () => {
    expect(estimateCost("claude-sonnet-4-6", 100_000, 10_000)).toBeCloseTo(0.45, 4);
    expect(estimateCost("claude-opus-4-7", 100_000, 10_000)).toBeCloseTo(2.25, 4);
  });

  test("falls back to default pricing for unknown models", () => {
    const fallback = estimateCost("future-model", 100_000, 10_000);
    expect(fallback).toBeGreaterThan(0);
  });
});
