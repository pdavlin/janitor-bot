#!/usr/bin/env bun
/**
 * Replay a captured weekly-review run with an optional prompt override.
 *
 * Reads a dump produced by `bun run weekly-review --dump`, optionally
 * swaps the system prompt, user prompt, or model, calls the live
 * Anthropic API, runs validation against the original transcript, and
 * prints a side-by-side comparison of original vs. replay findings.
 *
 * Usage:
 *   bun run scripts/replay-prompt.ts --dump path/to/dump.json
 *   bun run scripts/replay-prompt.ts --dump path/to/dump.json \
 *     --system path/to/new-system.txt
 *   bun run scripts/replay-prompt.ts --dump path/to/dump.json \
 *     --user path/to/new-user.txt --model claude-opus-4-7
 *
 * The script makes one API call per invocation. ANTHROPIC_API_KEY must
 * be set. The dump's transcript is used in-memory only (same privacy
 * posture as the original run); nothing is persisted beyond stdout.
 */

import { createLogger } from "../src/logger";
import { callAgent } from "../src/cli/weekly-review/agent";
import { validateFindings } from "../src/cli/weekly-review/validation";
import { buildTranscript } from "../src/cli/weekly-review/types";
import { readDump, type DumpRecord } from "../src/cli/weekly-review/dump";
import type { Finding } from "../src/cli/weekly-review/types";

interface CliArgs {
  dumpPath: string;
  systemOverridePath?: string;
  userOverridePath?: string;
  modelOverride?: string;
}

class CliInputError extends Error {}

function parseArgs(argv: readonly string[]): CliArgs {
  let dumpPath: string | undefined;
  let systemOverridePath: string | undefined;
  let userOverridePath: string | undefined;
  let modelOverride: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--dump": {
        const next = argv[++i];
        if (!next) throw new CliInputError("--dump requires a path");
        dumpPath = next;
        break;
      }
      case "--system": {
        const next = argv[++i];
        if (!next) throw new CliInputError("--system requires a path");
        systemOverridePath = next;
        break;
      }
      case "--user": {
        const next = argv[++i];
        if (!next) throw new CliInputError("--user requires a path");
        userOverridePath = next;
        break;
      }
      case "--model": {
        const next = argv[++i];
        if (!next) throw new CliInputError("--model requires a model name");
        modelOverride = next;
        break;
      }
      default:
        throw new CliInputError(`unknown argument: ${arg}`);
    }
  }

  if (!dumpPath) throw new CliInputError("--dump is required");
  return { dumpPath, systemOverridePath, userOverridePath, modelOverride };
}

async function loadOverride(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  return await Bun.file(path).text();
}

interface FindingsByType {
  finding_type: string;
  severity: string;
  evidence_strength: string;
  rule_area: string;
  play_count: number;
}

function summarize(findings: readonly Finding[]): FindingsByType[] {
  return findings.map((f) => ({
    finding_type: f.finding_type,
    severity: f.severity,
    evidence_strength: f.evidence_strength,
    rule_area: f.suspected_rule_area,
    play_count: f.evidence_play_ids.length,
  }));
}

function formatCard(label: string, items: FindingsByType[]): string {
  if (items.length === 0) return `${label}: (none)\n`;
  const lines = items.map(
    (i) =>
      `  • [${i.severity}, ${i.evidence_strength}] ${i.finding_type} ` +
      `— ${i.rule_area} — ${i.play_count} plays`,
  );
  return `${label} (${items.length}):\n${lines.join("\n")}\n`;
}

/**
 * Returns a finding_type that exists in `b` but not `a`. Used to
 * surface what changed between two replay runs without requiring an
 * exact-match diff (LLM responses vary even at temperature 0).
 */
function typeDiff(a: readonly Finding[], b: readonly Finding[]): string[] {
  const aTypes = new Set(a.map((f) => f.finding_type));
  return b.filter((f) => !aTypes.has(f.finding_type)).map((f) => f.finding_type);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for replay");
  }

  const dump: DumpRecord = await readDump(args.dumpPath);
  const systemOverride = await loadOverride(args.systemOverridePath);
  const userOverride = await loadOverride(args.userOverridePath);
  const model = args.modelOverride ?? dump.model;
  const logger = createLogger("warn");

  const replayPrompt = {
    system: systemOverride ?? dump.prompt.system,
    user: userOverride ?? dump.prompt.user,
    estimatedInputTokens: dump.prompt.estimatedInputTokens,
  };

  const transcript = buildTranscript(
    dump.transcript.games.map((g) => ({
      gamePk: g.gamePk,
      headerTs: g.headerTs,
      truncated: g.truncated,
      messages: g.messages,
    })),
  );

  process.stdout.write(`replaying dump captured ${dump.capturedAt}\n`);
  process.stdout.write(
    `  original: model=${dump.model}, accepted=${dump.validated.accepted.length}, rejected=${dump.validated.rejected.length}\n`,
  );
  process.stdout.write(
    `  replay:   model=${model}, ` +
      `system_override=${systemOverride ? "yes" : "no"}, ` +
      `user_override=${userOverride ? "yes" : "no"}\n\n`,
  );

  const result = await callAgent(apiKey, model, replayPrompt, logger);
  const validated = validateFindings(result.rawFindings, transcript, logger);

  const original = summarize(dump.validated.accepted);
  const replay = summarize(validated.accepted);

  process.stdout.write(formatCard("ORIGINAL accepted", original));
  process.stdout.write("\n");
  process.stdout.write(formatCard("REPLAY accepted", replay));
  process.stdout.write("\n");

  const newInReplay = typeDiff(dump.validated.accepted, validated.accepted);
  const droppedFromReplay = typeDiff(validated.accepted, dump.validated.accepted);

  if (newInReplay.length > 0) {
    process.stdout.write(`new in replay: ${newInReplay.join(", ")}\n`);
  }
  if (droppedFromReplay.length > 0) {
    process.stdout.write(
      `dropped vs original: ${droppedFromReplay.join(", ")}\n`,
    );
  }
  if (validated.rejected.length > 0) {
    const reasons = validated.rejected
      .map((r) => `${r.finding_type} (${r.reason})`)
      .join(", ");
    process.stdout.write(`replay rejections: ${reasons}\n`);
  }

  process.stdout.write(
    `\ncost: original=$${dump.response.estimatedCostUsd.toFixed(4)} ` +
      `replay=$${result.estimatedCostUsd.toFixed(4)} ` +
      `(input ${result.inputTokens}, output ${result.outputTokens})\n`,
  );
}

if (import.meta.main) {
  await main();
}
