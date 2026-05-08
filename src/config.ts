import type { Tier } from "./types/play";

const VALID_TIERS: readonly Tier[] = ["high", "medium", "low"] as const;
const VALID_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof VALID_LOG_LEVELS)[number];

export interface Config {
  slackWebhookUrl: string | undefined;
  slackBotToken: string | undefined;
  slackChannelId: string | undefined;
  slackSigningSecret: string | undefined;
  pollIntervalMinutes: number;
  backfillIntervalMinutes: number;
  dbPath: string;
  minTier: Tier | undefined;
  logLevel: LogLevel;
  port: number;
  /**
   * Anthropic API key for the weekly-review CLI. Read from env at load
   * time but only required at run time on the full-run path; CLI modes
   * that don't call the LLM (`--stats-only`, `--show-last`, `--dry-run`,
   * `--resolve`, `--force-clear-stale-lock`) tolerate `undefined`.
   */
  anthropicApiKey: string | undefined;
  /** Anthropic model identifier used by the weekly-review agent. */
  agentModel: string;
  /** Past-findings lookback (in weeks) used by the prompt builder. */
  agentHistoryWeeks: number;
}

export function loadConfig(): Config {
  const rawPollInterval = process.env.POLL_INTERVAL_MINUTES;
  let pollIntervalMinutes = 30;

  if (rawPollInterval !== undefined) {
    const parsed = Number(rawPollInterval);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid POLL_INTERVAL_MINUTES: "${rawPollInterval}". Must be a positive number.`
      );
    }
    pollIntervalMinutes = parsed;
  }

  const rawBackfillInterval = process.env.BACKFILL_INTERVAL_MINUTES;
  let backfillIntervalMinutes = 30;

  if (rawBackfillInterval !== undefined) {
    const parsed = Number(rawBackfillInterval);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid BACKFILL_INTERVAL_MINUTES: "${rawBackfillInterval}". Must be a positive number.`
      );
    }
    backfillIntervalMinutes = parsed;
  }

  const rawMinTier = process.env.MIN_TIER;
  let minTier: Tier | undefined;

  if (rawMinTier !== undefined) {
    if (!VALID_TIERS.includes(rawMinTier as Tier)) {
      throw new Error(
        `Invalid MIN_TIER: "${rawMinTier}". Must be one of: ${VALID_TIERS.join(", ")}.`
      );
    }
    minTier = rawMinTier as Tier;
  }

  const rawLogLevel = process.env.LOG_LEVEL;
  let logLevel: LogLevel = "info";

  if (rawLogLevel !== undefined) {
    if (!(VALID_LOG_LEVELS as readonly string[]).includes(rawLogLevel)) {
      throw new Error(
        `Invalid LOG_LEVEL: "${rawLogLevel}". Must be one of: ${VALID_LOG_LEVELS.join(", ")}.`
      );
    }
    logLevel = rawLogLevel as LogLevel;
  }

  const rawPort = process.env.PORT;
  let port = 3000;

  if (rawPort !== undefined) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(
        `Invalid PORT: "${rawPort}". Must be a positive integer between 1 and 65535.`
      );
    }
    port = parsed;
  }

  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackChannelId = process.env.SLACK_CHANNEL_ID;

  if (slackBotToken && !slackChannelId) {
    throw new Error(
      "SLACK_BOT_TOKEN is set but SLACK_CHANNEL_ID is not. Both are required for bot-token mode.",
    );
  }
  if (slackChannelId && !slackBotToken) {
    throw new Error(
      "SLACK_CHANNEL_ID is set but SLACK_BOT_TOKEN is not. Both are required for bot-token mode.",
    );
  }

  const rawAgentHistoryWeeks = process.env.AGENT_HISTORY_WEEKS;
  let agentHistoryWeeks = 8;
  if (rawAgentHistoryWeeks !== undefined) {
    const parsed = Number(rawAgentHistoryWeeks);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid AGENT_HISTORY_WEEKS: "${rawAgentHistoryWeeks}". Must be a positive integer.`,
      );
    }
    agentHistoryWeeks = parsed;
  }

  return {
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    slackBotToken,
    slackChannelId,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    pollIntervalMinutes,
    backfillIntervalMinutes,
    dbPath: process.env.DB_PATH ?? "./janitor-throws.db",
    minTier,
    logLevel,
    port,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    agentModel: process.env.AGENT_MODEL ?? "claude-sonnet-4-6",
    agentHistoryWeeks,
  };
}
