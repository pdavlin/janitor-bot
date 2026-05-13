import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../../storage/db";
import { createLogger } from "../../../logger";
import {
  callAgent,
  estimateCost,
  extractJsonPayload,
  type AgentClient,
  type AgentMessage,
  type ContentBlock,
} from "../agent";
import { WEEKLY_REVIEW_TOOLS } from "../tools";
import type { ToolContext } from "../tools/dispatch";
import type { BuiltPrompt } from "../prompt";
import type { DetectedPlay } from "../../../types/play";

const silentLogger = createLogger("error");

const PROMPT: BuiltPrompt = {
  system: "system text",
  user: "user text",
  estimatedInputTokens: 1000,
};

interface ToolUseSpec {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type FakeResponse =
  | { kind: "ok"; text: string; inputTokens?: number; outputTokens?: number }
  | {
      kind: "tool_use";
      blocks: ToolUseSpec[];
      inputTokens?: number;
      outputTokens?: number;
    }
  | { kind: "throw"; err: Error };

interface FakeClientOpts {
  responses: FakeResponse[];
}

interface FakeClient extends AgentClient {
  calls: number;
  lastMessages: AgentMessage[] | null;
}

function makeClient(opts: FakeClientOpts): FakeClient {
  let calls = 0;
  let lastMessages: AgentMessage[] | null = null;
  const client: FakeClient = {
    get calls() {
      return calls;
    },
    get lastMessages() {
      return lastMessages;
    },
    async create(input) {
      lastMessages = input.messages;
      const idx = calls;
      calls++;
      const next = opts.responses[idx];
      if (!next) throw new Error("unexpected extra call to agent client");
      if (next.kind === "throw") throw next.err;
      if (next.kind === "ok") {
        return {
          content: [{ type: "text", text: next.text }],
          usage: {
            input_tokens: next.inputTokens ?? 1000,
            output_tokens: next.outputTokens ?? 200,
          },
        };
      }
      const content: ContentBlock[] = next.blocks.map((b) => ({
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b.input,
      }));
      return {
        content,
        usage: {
          input_tokens: next.inputTokens ?? 1000,
          output_tokens: next.outputTokens ?? 200,
        },
      };
    },
  } as FakeClient;
  return client;
}

function makeToolContext(): ToolContext & { db: Database } {
  const db = createDatabase(":memory:");
  return { db, logger: silentLogger };
}

function seedPlay(db: Database, overrides: Partial<DetectedPlay> = {}): number {
  const play: DetectedPlay = {
    gamePk: 100,
    playIndex: 1,
    date: "2026-04-28",
    fielderId: 7,
    fielderName: "M",
    fielderPosition: "RF",
    runnerId: 1,
    runnerName: "R",
    targetBase: "Home",
    batterName: "B",
    inning: 7,
    halfInning: "top",
    awayScore: 3,
    homeScore: 2,
    awayTeam: "LAD",
    homeTeam: "SFG",
    description: "x",
    creditChain: "RF -> C",
    tier: "high",
    outs: 1,
    runnersOn: "1st",
    isOverturned: false,
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
  insertPlay(db, play);
  return (db.prepare("SELECT id FROM plays ORDER BY id DESC LIMIT 1;").get() as { id: number }).id;
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

  test("parses JSON wrapped in a ```json markdown fence", async () => {
    const fenced =
      '```json\n' +
      JSON.stringify({
        findings: [
          { finding_type: "fenced_one", description: "x", severity: "info" },
        ],
      }) +
      '\n```';
    const client = makeClient({ responses: [{ kind: "ok", text: fenced }] });
    const result = await callAgent(
      "k",
      "claude-sonnet-4-6",
      PROMPT,
      silentLogger,
      client,
    );
    expect(result.rawFindings).toHaveLength(1);
  });

  test("parses JSON wrapped in a bare ``` fence", async () => {
    const fenced =
      '```\n' +
      JSON.stringify({ findings: [{ finding_type: "bare_fence" }] }) +
      '\n```';
    const client = makeClient({ responses: [{ kind: "ok", text: fenced }] });
    const result = await callAgent(
      "k",
      "claude-sonnet-4-6",
      PROMPT,
      silentLogger,
      client,
    );
    expect(result.rawFindings).toHaveLength(1);
  });

  test("recovers JSON when the model adds prose before/after the object", async () => {
    const noisy =
      "Here are the findings I identified:\n\n" +
      JSON.stringify({ findings: [{ finding_type: "noisy_prose" }] }) +
      "\n\nLet me know if you need more.";
    const client = makeClient({ responses: [{ kind: "ok", text: noisy }] });
    const result = await callAgent(
      "k",
      "claude-sonnet-4-6",
      PROMPT,
      silentLogger,
      client,
    );
    expect(result.rawFindings).toHaveLength(1);
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

  test("populates toolCallCount=0 and empty breakdown on a single-turn run", async () => {
    const client = makeClient({
      responses: [{ kind: "ok", text: JSON.stringify({ findings: [] }) }],
    });
    const result = await callAgent(
      "k",
      "claude-sonnet-4-6",
      PROMPT,
      silentLogger,
      client,
    );
    expect(result.toolCallCount).toBe(0);
    expect(result.toolCallBreakdown).toEqual({});
  });
});

describe("callAgent tool-use loop", () => {
  test("dispatches a single tool call and continues to the final text", async () => {
    const ctx = makeToolContext();
    const playId = seedPlay(ctx.db);

    const client = makeClient({
      responses: [
        {
          kind: "tool_use",
          blocks: [{ id: "tu_1", name: "getVoteSnapshot", input: { playId } }],
        },
        {
          kind: "ok",
          text: JSON.stringify({
            findings: [
              { finding_type: "x", description: "abstract pattern", severity: "watch" },
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
      { tools: WEEKLY_REVIEW_TOOLS, toolContext: ctx },
    );
    expect(client.calls).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.toolCallBreakdown).toEqual({ getVoteSnapshot: 1 });

    // The follow-up call's messages should include the assistant turn and the
    // tool_result block.
    const messages = client.lastMessages!;
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const lastUser = messages[messages.length - 1]!;
    expect(lastUser.role).toBe("user");
    expect(Array.isArray(lastUser.content)).toBe(true);
    const blocks = lastUser.content as ContentBlock[];
    expect(blocks[0]?.type).toBe("tool_result");
    expect(blocks[0]?.tool_use_id).toBe("tu_1");
  });

  test("dispatches multiple tool_use blocks in a single response", async () => {
    const ctx = makeToolContext();
    const playId = seedPlay(ctx.db);

    const client = makeClient({
      responses: [
        {
          kind: "tool_use",
          blocks: [
            { id: "a", name: "getVoteSnapshot", input: { playId } },
            { id: "b", name: "getPlayDetails", input: { playId } },
            { id: "c", name: "getThreadMessageCount", input: { gamePk: 100 } },
          ],
        },
        { kind: "ok", text: JSON.stringify({ findings: [] }) },
      ],
    });

    const result = await callAgent(
      "k",
      "claude-sonnet-4-6",
      PROMPT,
      silentLogger,
      client,
      { tools: WEEKLY_REVIEW_TOOLS, toolContext: ctx },
    );
    expect(result.toolCallCount).toBe(3);
    expect(result.toolCallBreakdown).toEqual({
      getVoteSnapshot: 1,
      getPlayDetails: 1,
      getThreadMessageCount: 1,
    });
  });

  test("returns cost_cap_reached when the cost cap trips mid-loop", async () => {
    const ctx = makeToolContext();
    const playId = seedPlay(ctx.db);

    // Crank input_tokens so the first round trip's cost crosses $0.50.
    const client = makeClient({
      responses: [
        {
          kind: "tool_use",
          blocks: [
            { id: "a", name: "getVoteSnapshot", input: { playId } },
            { id: "b", name: "getVoteSnapshot", input: { playId } },
          ],
          inputTokens: 200_000,
          outputTokens: 0,
        },
        { kind: "ok", text: JSON.stringify({ findings: [] }) },
      ],
    });

    const result = await callAgent(
      "k",
      "claude-sonnet-4-6",
      PROMPT,
      silentLogger,
      client,
      { tools: WEEKLY_REVIEW_TOOLS, toolContext: ctx },
    );
    // Cost projection trips (200k input * $3/M = $0.60 > $0.50). All pending
    // tool requests in the same response receive cost_cap_reached results.
    expect(result.toolCallCount).toBe(0);
    expect(result.estimatedCostUsd).toBeGreaterThan(0.5);

    const lastUser = client.lastMessages![client.lastMessages!.length - 1]!;
    const blocks = lastUser.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const payload = JSON.parse(block.content as string) as { error: string };
      expect(payload.error).toBe("cost_cap_reached");
    }
  });

  test("converts a thrown tool implementation into internal_error and continues", async () => {
    const ctx = makeToolContext();
    // Don't seed any plays so getPlayTagsForPlay returns not_found, but make
    // the dispatcher actually throw by passing a malformed playId that the
    // not_found path handles. Instead, force a real throw by patching the db.
    const dbThrows = {
      prepare: () => { throw new Error("boom"); },
    } as unknown as Database;
    const brokenCtx: ToolContext = { db: dbThrows, logger: silentLogger };

    const client = makeClient({
      responses: [
        {
          kind: "tool_use",
          blocks: [{ id: "a", name: "getVoteSnapshot", input: { playId: 1 } }],
        },
        { kind: "ok", text: JSON.stringify({ findings: [] }) },
      ],
    });

    const result = await callAgent(
      "k",
      "claude-sonnet-4-6",
      PROMPT,
      silentLogger,
      client,
      { tools: WEEKLY_REVIEW_TOOLS, toolContext: brokenCtx },
    );
    expect(result.toolCallCount).toBe(1);

    const lastUser = client.lastMessages![client.lastMessages!.length - 1]!;
    const blocks = lastUser.content as ContentBlock[];
    const payload = JSON.parse(blocks[0]!.content as string) as { error: string };
    expect(payload.error).toBe("internal_error");
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

describe("extractJsonPayload", () => {
  test("returns text unchanged when it is already raw JSON", () => {
    const raw = '{"findings":[]}';
    expect(extractJsonPayload(raw)).toBe(raw);
  });

  test("strips a ```json fence", () => {
    const text = '```json\n{"findings":[]}\n```';
    expect(extractJsonPayload(text)).toBe('{"findings":[]}');
  });

  test("strips a bare ``` fence", () => {
    const text = '```\n{"findings":[]}\n```';
    expect(extractJsonPayload(text)).toBe('{"findings":[]}');
  });

  test("strips a fence even without a trailing newline", () => {
    const text = '```json{"findings":[]}```';
    expect(extractJsonPayload(text)).toBe('{"findings":[]}');
  });

  test("recovers from prose surrounding a JSON object", () => {
    const text = "Here are findings:\n{\"findings\":[]}\nDone.";
    expect(extractJsonPayload(text)).toBe('{"findings":[]}');
  });
});
