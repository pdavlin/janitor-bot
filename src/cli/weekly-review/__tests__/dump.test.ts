import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDump, writeDump, readDump } from "../dump";
import { buildTranscript } from "../types";
import type { ValidationResult } from "../validation";

const WINDOW = { weekStarting: "2026-04-26", weekEnding: "2026-05-02" };
const PROMPT = {
  system: "system text",
  user: "user text",
  estimatedInputTokens: 1234,
};
const SAMPLE_VALIDATED: ValidationResult = {
  accepted: [
    {
      finding_type: "rf_home_pushback",
      description: "Channel pushed back on RF to Home throws across multiple plays.",
      severity: "watch",
      evidence_strength: "moderate",
      evidence_play_ids: [1, 2, 3, 4],
      suspected_rule_area: "ranking.ts:target_base_scores",
      trend: "first_seen",
    },
  ],
  rejected: [{ finding_type: "x", reason: "description contains a quote character" }],
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wr-dump-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("buildDump", () => {
  test("captures the prompt, transcript, response, and validation result", () => {
    const transcript = buildTranscript([
      {
        gamePk: 100,
        headerTs: "1.000",
        truncated: false,
        messages: [{ text: "the play was great", user: "U1", ts: "1.001" }],
      },
    ]);

    const dump = buildDump({
      mode: "dryRun",
      model: "claude-sonnet-4-6",
      window: WINDOW,
      runId: null,
      prompt: PROMPT,
      transcript,
      response: {
        rawText: '{"findings":[]}',
        inputTokens: 1500,
        outputTokens: 200,
        estimatedCostUsd: 0.0123,
      },
      validated: SAMPLE_VALIDATED,
      gitSha: "abcdef0",
    });

    expect(dump.schemaVersion).toBe(1);
    expect(dump.mode).toBe("dryRun");
    expect(dump.model).toBe("claude-sonnet-4-6");
    expect(dump.window).toEqual(WINDOW);
    expect(dump.transcript.games).toHaveLength(1);
    expect(dump.transcript.games[0]!.messages[0]!.text).toBe("the play was great");
    expect(dump.validated.accepted).toHaveLength(1);
    expect(dump.gitSha).toBe("abcdef0");
  });
});

describe("writeDump / readDump", () => {
  test("round-trips a dump record through disk", async () => {
    const transcript = buildTranscript([]);
    const dump = buildDump({
      mode: "full",
      model: "claude-sonnet-4-6",
      window: WINDOW,
      runId: 42,
      prompt: PROMPT,
      transcript,
      response: {
        rawText: '{"findings":[]}',
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: 0.001,
      },
      validated: { accepted: [], rejected: [] },
      gitSha: null,
    });

    const path = await writeDump(dump, tempDir);
    expect(existsSync(path)).toBe(true);

    const loaded = await readDump(path);
    expect(loaded.runId).toBe(42);
    expect(loaded.window).toEqual(WINDOW);
    expect(loaded.gitSha).toBeNull();
  });

  test("filename embeds week + mode + model + timestamp", async () => {
    const dump = buildDump({
      mode: "dryRun",
      model: "claude-sonnet-4-6",
      window: WINDOW,
      runId: null,
      prompt: PROMPT,
      transcript: buildTranscript([]),
      response: {
        rawText: "{}",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
      validated: { accepted: [], rejected: [] },
      gitSha: null,
    });
    await writeDump(dump, tempDir);

    const files = readdirSync(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("2026-04-26");
    expect(files[0]).toContain("dryRun");
    expect(files[0]).toContain("claude-sonnet-4-6");
    expect(files[0]).toMatch(/\.json$/);
  });

  test("readDump rejects unsupported schemaVersion", async () => {
    const path = join(tempDir, "bad.json");
    await Bun.write(path, JSON.stringify({ schemaVersion: 99 }));
    await expect(readDump(path)).rejects.toThrow(/schemaVersion/);
  });
});
