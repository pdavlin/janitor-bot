/**
 * Tests for the config module.
 *
 * Each test manipulates process.env directly and restores original values
 * in afterEach to avoid leaking state between tests.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../config";

/** Env vars that loadConfig reads. */
const CONFIG_ENV_KEYS = [
  "SLACK_WEBHOOK_URL",
  "SLACK_BOT_TOKEN",
  "SLACK_CHANNEL_ID",
  "POLL_INTERVAL_MINUTES",
  "BACKFILL_INTERVAL_MINUTES",
  "DB_PATH",
  "MIN_TIER",
  "LOG_LEVEL",
] as const;

type ConfigEnvKey = (typeof CONFIG_ENV_KEYS)[number];

describe("loadConfig", () => {
  /** Snapshot of env values before each test. */
  let savedEnv: Record<ConfigEnvKey, string | undefined>;

  beforeEach(() => {
    savedEnv = {} as Record<ConfigEnvKey, string | undefined>;
    for (const key of CONFIG_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  // -------------------------------------------------------------------------
  // Default values
  // -------------------------------------------------------------------------

  test("returns defaults when no env vars are set", () => {
    const config = loadConfig();

    expect(config.pollIntervalMinutes).toBe(30);
    expect(config.backfillIntervalMinutes).toBe(30);
    expect(config.dbPath).toBe("./janitor-throws.db");
    expect(config.logLevel).toBe("info");
    expect(config.minTier).toBeUndefined();
    expect(config.slackWebhookUrl).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Individual env var overrides
  // -------------------------------------------------------------------------

  test("POLL_INTERVAL_MINUTES sets pollIntervalMinutes", () => {
    process.env.POLL_INTERVAL_MINUTES = "15";
    const config = loadConfig();
    expect(config.pollIntervalMinutes).toBe(15);
  });

  test("BACKFILL_INTERVAL_MINUTES sets backfillIntervalMinutes", () => {
    process.env.BACKFILL_INTERVAL_MINUTES = "60";
    const config = loadConfig();
    expect(config.backfillIntervalMinutes).toBe(60);
  });

  test("throws on invalid BACKFILL_INTERVAL_MINUTES", () => {
    process.env.BACKFILL_INTERVAL_MINUTES = "0";
    expect(() => loadConfig()).toThrow("Invalid BACKFILL_INTERVAL_MINUTES");
  });

  test("DB_PATH sets dbPath", () => {
    process.env.DB_PATH = "/tmp/test.db";
    const config = loadConfig();
    expect(config.dbPath).toBe("/tmp/test.db");
  });

  test("LOG_LEVEL sets logLevel", () => {
    process.env.LOG_LEVEL = "debug";
    const config = loadConfig();
    expect(config.logLevel).toBe("debug");
  });

  test("MIN_TIER sets minTier", () => {
    process.env.MIN_TIER = "high";
    const config = loadConfig();
    expect(config.minTier).toBe("high");
  });

  test("SLACK_WEBHOOK_URL passes through as-is", () => {
    const url = "https://hooks.slack.com/services/T00/B00/xxx";
    process.env.SLACK_WEBHOOK_URL = url;
    const config = loadConfig();
    expect(config.slackWebhookUrl).toBe(url);
  });

  test("SLACK_BOT_TOKEN + SLACK_CHANNEL_ID pass through together", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    const config = loadConfig();
    expect(config.slackBotToken).toBe("xoxb-test");
    expect(config.slackChannelId).toBe("C123");
  });

  test("throws when SLACK_BOT_TOKEN is set without SLACK_CHANNEL_ID", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    expect(() => loadConfig()).toThrow(/SLACK_BOT_TOKEN.*SLACK_CHANNEL_ID/);
  });

  test("throws when SLACK_CHANNEL_ID is set without SLACK_BOT_TOKEN", () => {
    process.env.SLACK_CHANNEL_ID = "C123";
    expect(() => loadConfig()).toThrow(/SLACK_CHANNEL_ID.*SLACK_BOT_TOKEN/);
  });

  // -------------------------------------------------------------------------
  // Validation errors
  // -------------------------------------------------------------------------

  test("throws on negative POLL_INTERVAL_MINUTES", () => {
    process.env.POLL_INTERVAL_MINUTES = "-5";
    expect(() => loadConfig()).toThrow("Invalid POLL_INTERVAL_MINUTES");
  });

  test("throws on zero POLL_INTERVAL_MINUTES", () => {
    process.env.POLL_INTERVAL_MINUTES = "0";
    expect(() => loadConfig()).toThrow("Invalid POLL_INTERVAL_MINUTES");
  });

  test("throws on non-numeric POLL_INTERVAL_MINUTES", () => {
    process.env.POLL_INTERVAL_MINUTES = "abc";
    expect(() => loadConfig()).toThrow("Invalid POLL_INTERVAL_MINUTES");
  });

  test("throws on invalid MIN_TIER", () => {
    process.env.MIN_TIER = "ultra";
    expect(() => loadConfig()).toThrow("Invalid MIN_TIER");
  });

  test("throws on invalid LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "verbose";
    expect(() => loadConfig()).toThrow("Invalid LOG_LEVEL");
  });
});
