/**
 * `bun run weekly-review` entry point.
 *
 * Single CLI with flag-based mode dispatch. The full-run path acquires
 * the per-week lock, gathers DB + Slack data, calls the LLM, validates
 * findings, persists, posts to Slack, and runs the retention sweep —
 * with a structurally guaranteed lock release in a finally block.
 *
 * Exit codes:
 *   0 — success or no-op
 *   1 — runtime error (LLM, Slack post, etc.)
 *   2 — concurrent run detected
 *   3 — bad CLI input or missing API key on the full-run path
 */

import { loadConfig, type Config } from "../config";
import { createLogger, type Logger } from "../logger";
import { createDatabase } from "../storage/db";
import type { Database } from "bun:sqlite";
import type { SlackClientConfig } from "../notifications/slack-client";

import { defaultCompletedWeek, explicitWeek, type WeekWindow } from "./weekly-review/week-window";
import { acquireLock, clearStaleLock, ConcurrentRunError } from "./weekly-review/lock";
import { computeBaseline } from "./weekly-review/baseline";
import { gather, totalVotes } from "./weekly-review/gather";
import { buildPrompt, type BuiltPrompt } from "./weekly-review/prompt";
import { callAgent, type AgentResult } from "./weekly-review/agent";
import { WEEKLY_REVIEW_TOOLS } from "./weekly-review/tools";
import { validateFindings, type ValidationResult } from "./weekly-review/validation";
import { RULE_AREAS } from "./weekly-review/rule-areas";
import {
  buildDump,
  writeDump,
  resolveGitSha,
} from "./weekly-review/dump";
import { notifyOperator } from "./weekly-review/notify-operator";
import type { Transcript } from "./weekly-review/types";
import {
  persistFindings,
  recordAgentTelemetry,
  runRetentionSweep,
  autoCloseStaleFindings,
  getHitRate,
  resolveFinding,
  queryLastRunFindings,
} from "./weekly-review/findings-store";
import {
  buildDigest,
  buildInsufficientDigest,
  buildEmptyDigest,
  buildAllRejectedDigest,
  buildStatsOnlyDigest,
  byMinStrength,
  orderFindings,
  postDigest,
} from "./weekly-review/digest";
import { postFindingReplies } from "./weekly-review/post-finding-replies";
import type { Outcome } from "./weekly-review/types";

interface ParsedFlags {
  mode:
    | "full"
    | "dryRun"
    | "statsOnly"
    | "showLast"
    | "resolve"
    | "forceClearStaleLock";
  weekStarting?: string;
  minStrength?: "weak" | "moderate" | "strong";
  resolveArgs?: { runId: number; findingId: number; outcome: Extract<Outcome, "confirmed" | "rejected"> };
  /** True when --dump was passed; full and dry-run modes capture a JSON record. */
  dump: boolean;
  /** Optional override for the dump destination directory. */
  dumpDir?: string;
}

class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliInputError";
  }
}

function parseArgs(argv: readonly string[]): ParsedFlags {
  const positional: string[] = [];
  let mode: ParsedFlags["mode"] = "full";
  let weekStarting: string | undefined;
  let minStrength: ParsedFlags["minStrength"];
  let dump = false;
  let dumpDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--dry-run":
        mode = "dryRun";
        break;
      case "--stats-only":
        mode = "statsOnly";
        break;
      case "--show-last":
        mode = "showLast";
        break;
      case "--resolve":
        mode = "resolve";
        break;
      case "--force-clear-stale-lock":
        mode = "forceClearStaleLock";
        break;
      case "--week-starting": {
        const next = argv[++i];
        if (!next) throw new CliInputError("--week-starting requires a YYYY-MM-DD value");
        weekStarting = next;
        break;
      }
      case "--min-strength": {
        const next = argv[++i];
        if (next !== "weak" && next !== "moderate" && next !== "strong") {
          throw new CliInputError(
            `--min-strength must be weak|moderate|strong (got ${next ?? "<missing>"})`,
          );
        }
        minStrength = next;
        break;
      }
      case "--dump":
        dump = true;
        break;
      case "--dump-dir": {
        const next = argv[++i];
        if (!next) throw new CliInputError("--dump-dir requires a path");
        dumpDir = next;
        break;
      }
      default:
        if (arg.startsWith("--")) {
          throw new CliInputError(`unknown flag: ${arg}`);
        }
        positional.push(arg);
    }
  }

  if (mode === "resolve") {
    if (positional.length !== 3) {
      throw new CliInputError(
        "--resolve requires <run_id> <finding_id> <confirmed|rejected>",
      );
    }
    const runId = Number(positional[0]);
    const findingId = Number(positional[1]);
    const outcome = positional[2];
    if (!Number.isInteger(runId) || !Number.isInteger(findingId)) {
      throw new CliInputError("--resolve run_id and finding_id must be integers");
    }
    if (outcome !== "confirmed" && outcome !== "rejected") {
      throw new CliInputError("--resolve outcome must be confirmed or rejected");
    }
    return {
      mode,
      weekStarting,
      minStrength,
      resolveArgs: { runId, findingId, outcome },
      dump,
      dumpDir,
    };
  }

  return { mode, weekStarting, minStrength, dump, dumpDir };
}

function toSlackClientConfig(config: Config): SlackClientConfig {
  return {
    botToken: config.slackBotToken,
    channelId: config.slackChannelId,
    webhookUrl: config.slackWebhookUrl,
  };
}

function resolveWindow(flags: ParsedFlags): WeekWindow {
  return flags.weekStarting
    ? explicitWeek(flags.weekStarting)
    : defaultCompletedWeek();
}

/**
 * Best-effort lookup of the blocking `started` row for the
 * concurrent_run_blocked DM. Returns null on any failure (DB locked,
 * row missing) — the DM still fires, just without the run id.
 */
function lookupBlockingRunId(db: Database, weekStarting: string): number | null {
  try {
    const row = db
      .prepare(
        `SELECT id FROM agent_runs WHERE week_starting = $week AND status = 'started' LIMIT 1;`,
      )
      .get({ $week: weekStarting }) as { id: number } | null;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** Maps the validator's verbose reason strings to short DM keys. */
function simplifyReason(reason: string): string {
  if (reason.includes("quote")) return "quote";
  if (reason.includes("mention")) return "mention";
  if (reason.includes("substring")) return "substring";
  if (
    reason.includes("missing") ||
    reason.includes("invalid") ||
    reason.includes("non-integer") ||
    reason.includes("not an object")
  ) {
    return "shape";
  }
  return "other";
}

interface WriteRunDumpInput {
  flags: ParsedFlags;
  mode: "full" | "dryRun";
  model: string;
  window: WeekWindow;
  runId: number | null;
  prompt: BuiltPrompt;
  transcript: Transcript;
  agentResult: AgentResult;
  validated: ValidationResult;
  logger: Logger;
}

const DEFAULT_DUMP_DIR = "./weekly-review-dumps";

/**
 * Persists a JSON dump of the run for offline prompt iteration.
 * Failures are logged at warn level and never break the run — the
 * dump is an aside, not a critical path. Returns the absolute path
 * on success, or null when the write failed (so trigger sites that
 * want to reference the dump file can short-circuit cleanly).
 */
async function writeRunDump(input: WriteRunDumpInput): Promise<string | null> {
  const dumpDir = input.flags.dumpDir ?? DEFAULT_DUMP_DIR;
  const dump = buildDump({
    mode: input.mode,
    model: input.model,
    window: input.window,
    runId: input.runId,
    prompt: input.prompt,
    transcript: input.transcript,
    response: {
      rawText: input.agentResult.rawText,
      inputTokens: input.agentResult.inputTokens,
      outputTokens: input.agentResult.outputTokens,
      estimatedCostUsd: input.agentResult.estimatedCostUsd,
      toolCallCount: input.agentResult.toolCallCount,
      toolCallBreakdown: input.agentResult.toolCallBreakdown,
    },
    validated: input.validated,
    gitSha: resolveGitSha(),
  });
  try {
    const path = await writeDump(dump, dumpDir);
    input.logger.info("dump written", { path });
    return path;
  } catch (err) {
    input.logger.warn("dump write failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function runFull(
  db: Database,
  config: Config,
  logger: Logger,
  flags: ParsedFlags,
): Promise<number> {
  if (!config.anthropicApiKey) {
    logger.error("ANTHROPIC_API_KEY is required for the full run", {
      hint: "use --stats-only or --dry-run if you intend to skip the LLM call",
    });
    return 3;
  }
  if (!config.slackChannelId) {
    logger.error("SLACK_CHANNEL_ID is required for the full run");
    return 3;
  }

  const window = resolveWindow(flags);
  const slackConfig = toSlackClientConfig(config);

  let lock;
  try {
    lock = acquireLock(db, window.weekStarting, config.agentModel);
  } catch (err) {
    if (err instanceof ConcurrentRunError) {
      logger.error(err.message);
      await notifyOperator(slackConfig, config.operatorUserId, {
        kind: "concurrent_run_blocked",
        ctx: {
          weekStarting: window.weekStarting,
          blockingRunId: lookupBlockingRunId(db, window.weekStarting),
        },
      }, logger);
      return 2;
    }
    throw err;
  }

  let releaseStatus: "success" | "error" = "error";
  let releaseError: string | undefined;
  try {
    const baseline = computeBaseline(db, window);
    const gathered = await gather(
      db,
      slackConfig,
      window,
      config.agentHistoryWeeks,
      logger,
    );

    const playCount = gathered.plays.length;
    const voteCount = totalVotes(gathered);

    if (playCount < 5 || voteCount < 5) {
      logger.info("minimum-signal gate triggered, skipping LLM", {
        playCount,
        voteCount,
      });
      const message = buildInsufficientDigest(window, playCount, voteCount);
      const ts = await postDigest(slackConfig, config.slackChannelId, message, logger);
      recordAgentTelemetry(db, lock.runId, 0, 0, 0, ts?.ts ?? null, 0, {});
      releaseStatus = ts ? "success" : "error";
      if (!ts) releaseError = "slack post failed";
      return ts ? 0 : 1;
    }

    const prompt = buildPrompt({
      window,
      baseline,
      plays: gathered.plays,
      snapshots: gathered.snapshots,
      tags: gathered.tags,
      transcript: gathered.transcript,
      channelCorrections: gathered.channelCorrections,
      priorFindings: gathered.priorFindings,
      ruleAreas: RULE_AREAS,
    });

    const agentResult = await callAgent(
      config.anthropicApiKey,
      config.agentModel,
      prompt,
      logger,
      undefined,
      {
        tools: WEEKLY_REVIEW_TOOLS,
        toolContext: { db, logger },
      },
    );

    const validated = validateFindings(
      agentResult.rawFindings,
      gathered.transcript,
      logger,
    );
    const ordered = orderFindings(validated.accepted).filter(
      byMinStrength(flags.minStrength),
    );

    const findingIds = persistFindings(db, lock.runId, ordered);

    let dumpPath: string | null = null;
    if (flags.dump) {
      dumpPath = await writeRunDump({
        flags,
        mode: "full",
        model: config.agentModel,
        window,
        runId: lock.runId,
        prompt,
        transcript: gathered.transcript,
        agentResult,
        validated,
        logger,
      });
    }

    const hitRate = getHitRate(db);
    const message =
      ordered.length > 0
        ? buildDigest({
            window,
            baseline,
            findings: ordered,
            hitRate,
            runId: lock.runId,
          })
        : validated.rejected.length > 0
          ? buildAllRejectedDigest(window, baseline, hitRate, validated.rejected.length)
          : buildEmptyDigest(window, baseline, hitRate);

    const ts = await postDigest(slackConfig, config.slackChannelId, message, logger);
    if (!ts) {
      releaseError = "slack post failed";
      return 1;
    }

    if (ordered.length > 0) {
      try {
        await postFindingReplies(
          db,
          slackConfig,
          { channel: config.slackChannelId, ts: ts.ts, runId: lock.runId },
          ordered,
          findingIds,
          logger,
        );
      } catch (err) {
        logger.warn("post-finding replies failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    recordAgentTelemetry(
      db,
      lock.runId,
      agentResult.inputTokens,
      agentResult.outputTokens,
      agentResult.estimatedCostUsd,
      ts.ts,
      agentResult.toolCallCount,
      agentResult.toolCallBreakdown,
    );

    logger.info("agent run tool telemetry", {
      toolCallCount: agentResult.toolCallCount,
      toolCallBreakdown: agentResult.toolCallBreakdown,
    });

    if (dumpPath !== null) {
      await notifyOperator(slackConfig, config.operatorUserId, {
        kind: "dump_captured",
        ctx: {
          weekStarting: window.weekStarting,
          weekEnding: window.weekEnding,
          runId: lock.runId,
          model: config.agentModel,
          dumpPath,
          acceptedCount: validated.accepted.length,
          rejectedCount: validated.rejected.length,
          estimatedCostUsd: agentResult.estimatedCostUsd,
        },
      }, logger);
    }

    if (ordered.length === 0 && validated.rejected.length > 0) {
      const rejectionsByReason: Record<string, number> = {};
      for (const r of validated.rejected) {
        const key = simplifyReason(r.reason);
        rejectionsByReason[key] = (rejectionsByReason[key] ?? 0) + 1;
      }
      await notifyOperator(slackConfig, config.operatorUserId, {
        kind: "all_findings_rejected",
        ctx: {
          runId: lock.runId,
          weekStarting: window.weekStarting,
          rejectionsByReason,
          totalRejected: validated.rejected.length,
        },
      }, logger);
    }

    try {
      runRetentionSweep(db);
      autoCloseStaleFindings(db);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.warn("retention sweep failed", { error: errMessage });
      await notifyOperator(slackConfig, config.operatorUserId, {
        kind: "retention_sweep_failed",
        ctx: { runId: lock.runId, errorMessage: errMessage },
      }, logger);
    }

    releaseStatus = "success";
    return 0;
  } catch (err) {
    releaseError = err instanceof Error ? err.message : String(err);
    logger.error("weekly-review run failed", { error: releaseError });
    return 1;
  } finally {
    lock.release(releaseStatus, releaseError);
  }
}

async function runStatsOnly(
  db: Database,
  config: Config,
  logger: Logger,
  flags: ParsedFlags,
): Promise<number> {
  if (!config.slackChannelId) {
    logger.error("SLACK_CHANNEL_ID is required for stats-only mode");
    return 3;
  }

  const window = resolveWindow(flags);
  const slackConfig = toSlackClientConfig(config);

  let lock;
  try {
    lock = acquireLock(db, window.weekStarting, "stats-only");
  } catch (err) {
    if (err instanceof ConcurrentRunError) {
      logger.error(err.message);
      await notifyOperator(slackConfig, config.operatorUserId, {
        kind: "concurrent_run_blocked",
        ctx: {
          weekStarting: window.weekStarting,
          blockingRunId: lookupBlockingRunId(db, window.weekStarting),
        },
      }, logger);
      return 2;
    }
    throw err;
  }

  let releaseStatus: "success" | "error" = "error";
  let releaseError: string | undefined;
  try {
    const baseline = computeBaseline(db, window);
    const message = buildStatsOnlyDigest(window, baseline);
    const ts = await postDigest(slackConfig, config.slackChannelId, message, logger);
    if (!ts) {
      releaseError = "slack post failed";
      return 1;
    }
    recordAgentTelemetry(db, lock.runId, 0, 0, 0, ts.ts, 0, {});
    releaseStatus = "success";
    return 0;
  } catch (err) {
    releaseError = err instanceof Error ? err.message : String(err);
    logger.error("stats-only run failed", { error: releaseError });
    return 1;
  } finally {
    lock.release(releaseStatus, releaseError);
  }
}

async function runDryRun(
  db: Database,
  config: Config,
  logger: Logger,
  flags: ParsedFlags,
): Promise<number> {
  // Dry-run writes nothing and acquires no lock. Two parallel dry-runs
  // are safe — they both just print to stdout.
  const window = resolveWindow(flags);
  const slackConfig = toSlackClientConfig(config);

  const baseline = computeBaseline(db, window);
  const gathered = await gather(
    db,
    slackConfig,
    window,
    config.agentHistoryWeeks,
    logger,
  );
  const prompt = buildPrompt({
    window,
    baseline,
    plays: gathered.plays,
    snapshots: gathered.snapshots,
    tags: gathered.tags,
    transcript: gathered.transcript,
    channelCorrections: gathered.channelCorrections,
    priorFindings: gathered.priorFindings,
    ruleAreas: RULE_AREAS,
  });

  process.stdout.write("=== SYSTEM PROMPT ===\n\n");
  process.stdout.write(prompt.system);
  process.stdout.write("\n\n=== USER PROMPT ===\n\n");
  process.stdout.write(prompt.user);
  process.stdout.write(`\n\n=== ESTIMATED INPUT TOKENS: ${prompt.estimatedInputTokens} ===\n`);

  if (!config.anthropicApiKey) {
    process.stdout.write("\n=== ANTHROPIC_API_KEY not set; skipping LLM call ===\n");
    return 0;
  }

  process.stdout.write(
    "\n=== AGENT RESPONSE (calling LLM, no DB or Slack writes) ===\n\n",
  );
  const result = await callAgent(
    config.anthropicApiKey,
    config.agentModel,
    prompt,
    logger,
    undefined,
    {
      tools: WEEKLY_REVIEW_TOOLS,
      toolContext: { db, logger },
    },
  );
  const validated = validateFindings(result.rawFindings, gathered.transcript, logger);
  process.stdout.write(
    JSON.stringify(
      {
        accepted: validated.accepted,
        rejected: validated.rejected,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        toolCallCount: result.toolCallCount,
        toolCallBreakdown: result.toolCallBreakdown,
      },
      null,
      2,
    ),
  );
  process.stdout.write("\n");

  if (flags.dump) {
    await writeRunDump({
      flags,
      mode: "dryRun",
      model: config.agentModel,
      window,
      runId: null,
      prompt,
      transcript: gathered.transcript,
      agentResult: result,
      validated,
      logger,
    });
  }

  return 0;
}

function formatToolBreakdown(breakdownJson: string | null): string {
  if (!breakdownJson) return "";
  let parsed: Record<string, number>;
  try {
    parsed = JSON.parse(breakdownJson) as Record<string, number>;
  } catch {
    return "";
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) return "";
  return entries.map(([name, count]) => `${name}: ${count}`).join(", ");
}

function runShowLast(db: Database): number {
  const { run, findings } = queryLastRunFindings(db);
  if (!run) {
    process.stdout.write("No successful run found.\n");
    return 0;
  }
  process.stdout.write(
    `Run #${run.id} (week of ${run.week_starting}) — ${findings.length} findings:\n`,
  );
  if (run.tool_call_count !== null) {
    const breakdown = formatToolBreakdown(run.tool_call_breakdown);
    const suffix = breakdown.length > 0 ? ` (${breakdown})` : "";
    process.stdout.write(`Tool calls: ${run.tool_call_count}${suffix}\n`);
  }
  for (const f of findings) {
    const playIds = JSON.parse(f.evidence_play_ids) as number[];
    process.stdout.write(
      `  [${f.severity}, ${f.evidence_strength}] ${f.finding_type} — ` +
        `area: ${f.suspected_rule_area} — ${playIds.length} plays — outcome: ${f.outcome}\n`,
    );
    if (f.description) {
      process.stdout.write(`    ${f.description}\n`);
    }
  }
  return 0;
}

function runResolve(db: Database, logger: Logger, flags: ParsedFlags): number {
  if (!flags.resolveArgs) return 3;
  const ok = resolveFinding(
    db,
    flags.resolveArgs.runId,
    flags.resolveArgs.findingId,
    flags.resolveArgs.outcome,
  );
  if (!ok) {
    logger.error("no matching finding for that run/finding pair", {
      runId: flags.resolveArgs.runId,
      findingId: flags.resolveArgs.findingId,
    });
    return 1;
  }
  process.stdout.write(
    `Resolved finding ${flags.resolveArgs.findingId} as ${flags.resolveArgs.outcome}.\n`,
  );
  return 0;
}

function runForceClearStaleLock(
  db: Database,
  logger: Logger,
  flags: ParsedFlags,
): number {
  if (!flags.weekStarting) {
    logger.error("--force-clear-stale-lock requires --week-starting");
    return 3;
  }
  const window = explicitWeek(flags.weekStarting);
  const deleted = clearStaleLock(db, window.weekStarting);
  logger.warn("cleared stale started rows", {
    weekStarting: window.weekStarting,
    deleted,
  });
  return 0;
}

export async function runWeeklyReview(argv: readonly string[]): Promise<number> {
  let flags: ParsedFlags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliInputError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 3;
    }
    throw err;
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = createDatabase(config.dbPath);

  try {
    switch (flags.mode) {
      case "showLast":
        return runShowLast(db);
      case "resolve":
        return runResolve(db, logger, flags);
      case "forceClearStaleLock":
        return runForceClearStaleLock(db, logger, flags);
      case "statsOnly":
        return await runStatsOnly(db, config, logger, flags);
      case "dryRun":
        return await runDryRun(db, config, logger, flags);
      case "full":
        return await runFull(db, config, logger, flags);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const code = await runWeeklyReview(Bun.argv.slice(2));
  process.exit(code);
}
