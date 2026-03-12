import type { Tier } from "./types/play";

const VALID_TIERS: readonly Tier[] = ["high", "medium", "low"] as const;
const VALID_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof VALID_LOG_LEVELS)[number];

export interface Config {
  slackWebhookUrl: string | undefined;
  pollIntervalMinutes: number;
  dbPath: string;
  minTier: Tier | undefined;
  logLevel: LogLevel;
  port: number;
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

  return {
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    pollIntervalMinutes,
    dbPath: process.env.DB_PATH ?? "./janitor-throws.db",
    minTier,
    logLevel,
    port,
  };
}
