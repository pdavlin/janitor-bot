/**
 * Operator-controlled run dumps for prompt iteration / eval.
 *
 * `--dump` opts a single run into capturing the full prompt + raw API
 * response + parsed findings to a JSON file on disk. This is for the
 * operator's local eval workflow — it is NOT a logging path the bot
 * uses by default. The dump file contains transcript content, so the
 * directory is the operator's responsibility (default
 * `./weekly-review-dumps/` is gitignored at the repo root).
 *
 * Replay against a captured dump is via `scripts/replay-prompt.ts`.
 */

// transcript-leakage-allowed: dumps capture the prompt + transcript
// for explicit, opt-in operator eval. The runtime only writes when
// --dump is passed; the leakage check still rejects DB / logger /
// Slack-API sinks in this file via the strict-sink rule.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ValidationResult } from "./validation";
import type { BuiltPrompt } from "./prompt";
import type { Transcript } from "./types";
import type { WeekWindow } from "./week-window";

export interface AgentDumpResponse {
  /** Original API response text, before fence-stripping. */
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/**
 * Self-contained snapshot of one weekly-review run. All fields needed
 * for replay are present so `replay-prompt.ts` can execute without
 * touching the live DB or Slack.
 */
export interface DumpRecord {
  schemaVersion: 1;
  capturedAt: string;
  gitSha: string | null;
  mode: "full" | "dryRun";
  model: string;
  window: WeekWindow;
  runId: number | null;
  prompt: {
    system: string;
    user: string;
    estimatedInputTokens: number;
  };
  /**
   * Structured transcript content. Required for replay so a revised
   * system prompt can be re-validated against transcript-substring
   * matches without re-fetching from Slack.
   */
  transcript: {
    games: {
      gamePk: number;
      headerTs: string;
      truncated: boolean;
      messages: { text: string; user: string; ts: string }[];
    }[];
  };
  response: AgentDumpResponse;
  validated: ValidationResult;
}

export interface BuildDumpInput {
  mode: "full" | "dryRun";
  model: string;
  window: WeekWindow;
  runId: number | null;
  prompt: BuiltPrompt;
  transcript: Transcript;
  response: AgentDumpResponse;
  validated: ValidationResult;
  gitSha: string | null;
}

/** Constructs an in-memory dump record. Pure; no I/O. */
export function buildDump(input: BuildDumpInput): DumpRecord {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    gitSha: input.gitSha,
    mode: input.mode,
    model: input.model,
    window: input.window,
    runId: input.runId,
    prompt: {
      system: input.prompt.system,
      user: input.prompt.user,
      estimatedInputTokens: input.prompt.estimatedInputTokens,
    },
    transcript: {
      games: input.transcript.games.map((g) => ({
        gamePk: g.gamePk,
        headerTs: g.headerTs,
        truncated: g.truncated,
        messages: g.messages.map((m) => ({
          text: m.text,
          user: m.user,
          ts: m.ts,
        })),
      })),
    },
    response: input.response,
    validated: input.validated,
  };
}

/**
 * Writes the dump record as pretty-printed JSON to a path under
 * `dumpDir`. The filename embeds the run mode, week, model, and a
 * timestamp for human-readable browsing.
 *
 * Returns the absolute path that was written.
 */
export async function writeDump(
  dump: DumpRecord,
  dumpDir: string,
): Promise<string> {
  const safeModel = dump.model.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ts = dump.capturedAt.replace(/[:.]/g, "-");
  const filename = `${dump.window.weekStarting}_${dump.mode}_${safeModel}_${ts}.json`;
  const fullPath = join(dumpDir, filename);
  mkdirSync(dirname(fullPath), { recursive: true });
  await Bun.write(fullPath, JSON.stringify(dump, null, 2));
  return fullPath;
}

/**
 * Reads a dump file from disk. Validates `schemaVersion` so future
 * format changes fail loudly instead of silently mis-replaying.
 */
export async function readDump(path: string): Promise<DumpRecord> {
  const text = await Bun.file(path).text();
  const parsed = JSON.parse(text) as { schemaVersion?: number };
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `dump at ${path} has unsupported schemaVersion=${parsed.schemaVersion ?? "<missing>"}`,
    );
  }
  return parsed as DumpRecord;
}

/**
 * Best-effort git SHA at run time. Returns null when not in a git
 * working tree (e.g. on a deploy that's been moved out of git).
 */
export function resolveGitSha(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}
