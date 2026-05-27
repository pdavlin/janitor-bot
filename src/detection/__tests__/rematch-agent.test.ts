import { test, expect, describe } from "bun:test";
import { createLogger } from "../../logger";
import {
  AgentTimeoutError,
  type AgentClient,
  type ContentBlock,
} from "../../cli/weekly-review/agent";
import {
  rematchVideo,
  type RematchCandidate,
  type RematchInput,
} from "../rematch-agent";

const silentLogger = createLogger("error");

const CANDIDATES: RematchCandidate[] = [
  { id: "v_alpha", description: "Betts throws out Acuna at third in the 7th" },
  { id: "v_beta", description: "Acuna's RBI single off the wall in the 7th" },
  { id: "v_gamma", description: "Freeman doubles to left in the 5th" },
];

function inputWith(overrides: Partial<RematchInput> = {}): RematchInput {
  return {
    playDescription:
      "Acuna grounds into fielder's choice; Betts to second on the throw.",
    currentVideoId: "v_beta",
    candidates: CANDIDATES,
    gamePk: 776123,
    ...overrides,
  };
}

interface ToolUseSpec {
  id?: string;
  name?: string;
  input: unknown;
}

type FakeResponse =
  | { kind: "tool_use"; tool: ToolUseSpec; inputTokens?: number; outputTokens?: number }
  | { kind: "text"; text: string; inputTokens?: number; outputTokens?: number }
  | { kind: "throw"; err: Error };

interface FakeClient extends AgentClient {
  calls: number;
}

function makeClient(responses: FakeResponse[]): FakeClient {
  let calls = 0;
  const client: FakeClient = {
    get calls() {
      return calls;
    },
    async create() {
      const idx = calls;
      calls++;
      const next = responses[idx];
      if (!next) throw new Error(`unexpected extra call #${idx} to fake client`);
      if (next.kind === "throw") throw next.err;
      const usage = {
        input_tokens: next.inputTokens ?? 800,
        output_tokens: next.outputTokens ?? 80,
      };
      if (next.kind === "text") {
        return {
          content: [{ type: "text", text: next.text }] as ContentBlock[],
          usage,
        };
      }
      const block: ContentBlock = {
        type: "tool_use",
        id: next.tool.id ?? "toolu_1",
        name: next.tool.name ?? "pick_video",
        input: next.tool.input,
      };
      return { content: [block], usage };
    },
  } as FakeClient;
  return client;
}

describe("rematchVideo", () => {
  test("returns swapped when agent picks a different valid candidate", async () => {
    const client = makeClient([
      {
        kind: "tool_use",
        tool: {
          input: { video_id: "v_alpha", reason: "RF assist matches play" },
        },
      },
    ]);
    const result = await rematchVideo(
      "key",
      "claude-sonnet-4-6",
      inputWith(),
      silentLogger,
      client,
    );
    expect(result).toEqual({
      decision: "swapped",
      videoId: "v_alpha",
      reason: "RF assist matches play",
    });
    expect(client.calls).toBe(1);
  });

  test("returns agreed when agent picks currentVideoId", async () => {
    const client = makeClient([
      {
        kind: "tool_use",
        tool: { input: { video_id: "v_beta", reason: "current is correct" } },
      },
    ]);
    const result = await rematchVideo(
      "key",
      "claude-sonnet-4-6",
      inputWith(),
      silentLogger,
      client,
    );
    expect(result).toEqual({ decision: "agreed", reason: "current is correct" });
  });

  test("returns no_match when video_id is null", async () => {
    const client = makeClient([
      {
        kind: "tool_use",
        tool: { input: { video_id: null, reason: "nothing fits" } },
      },
    ]);
    const result = await rematchVideo(
      "key",
      "claude-sonnet-4-6",
      inputWith(),
      silentLogger,
      client,
    );
    expect(result).toEqual({ decision: "no_match", reason: "nothing fits" });
  });

  test("returns no_match when video_id is not in candidates", async () => {
    const client = makeClient([
      {
        kind: "tool_use",
        tool: { input: { video_id: "v_unknown", reason: "guessed" } },
      },
    ]);
    const result = await rematchVideo(
      "key",
      "claude-sonnet-4-6",
      inputWith(),
      silentLogger,
      client,
    );
    expect(result.decision).toBe("no_match");
  });

  test("returns swapped (not agreed) when currentVideoId is null and a candidate is picked", async () => {
    const client = makeClient([
      {
        kind: "tool_use",
        tool: { input: { video_id: "v_gamma", reason: "first-pass empty" } },
      },
    ]);
    const result = await rematchVideo(
      "key",
      "claude-sonnet-4-6",
      inputWith({ currentVideoId: null }),
      silentLogger,
      client,
    );
    expect(result).toEqual({
      decision: "swapped",
      videoId: "v_gamma",
      reason: "first-pass empty",
    });
  });

  test("returns no_match when agent never calls pick_video", async () => {
    const client = makeClient([
      { kind: "text", text: "thinking..." },
      { kind: "text", text: "still thinking..." },
      { kind: "text", text: "no decision" },
    ]);
    const result = await rematchVideo(
      "key",
      "claude-sonnet-4-6",
      inputWith(),
      silentLogger,
      client,
    );
    expect(result.decision).toBe("no_match");
    expect(client.calls).toBe(3);
  });

  test(
    "retries once on transient error and returns the second call's decision",
    async () => {
      // RETRY_DELAY_MS is 5s in the module; allow extra headroom.
      const client = makeClient([
        { kind: "throw", err: new AgentTimeoutError("timeout") },
        {
          kind: "tool_use",
          tool: { input: { video_id: "v_alpha", reason: "after retry" } },
        },
      ]);
      const result = await rematchVideo(
        "key",
        "claude-sonnet-4-6",
        inputWith(),
        silentLogger,
        client,
      );
      expect(result).toEqual({
        decision: "swapped",
        videoId: "v_alpha",
        reason: "after retry",
      });
      expect(client.calls).toBe(2);
    },
    10_000,
  );

  test("propagates non-transient errors immediately", async () => {
    const authError = new Error("invalid api key");
    const client = makeClient([{ kind: "throw", err: authError }]);
    await expect(
      rematchVideo("key", "claude-sonnet-4-6", inputWith(), silentLogger, client),
    ).rejects.toThrow("invalid api key");
    expect(client.calls).toBe(1);
  });

  test("treats malformed tool input as no_match", async () => {
    const client = makeClient([
      { kind: "tool_use", tool: { input: "not an object" } },
    ]);
    const result = await rematchVideo(
      "key",
      "claude-sonnet-4-6",
      inputWith(),
      silentLogger,
      client,
    );
    expect(result.decision).toBe("no_match");
  });
});
