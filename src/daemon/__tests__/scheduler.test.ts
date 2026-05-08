/**
 * Tests for the scheduler shutdown coordination utilities.
 *
 * The scheduler's main loop (startScheduler) is tightly coupled to the MLB API
 * and resets its own shutdown flag on entry, so direct unit testing of the loop
 * is limited. These tests verify the shutdown helpers and confirm the flag
 * mechanism works when triggered mid-execution.
 */

import { test, expect, describe, afterEach, mock } from "bun:test";
import { requestShutdown, resetShutdown, startScheduler } from "../scheduler";
import type { Config } from "../../config";
import type { Logger } from "../../logger";
import type { Database } from "bun:sqlite";

/** Minimal config that won't trigger real side effects. */
function makeTestConfig(): Config {
  return {
    slackWebhookUrl: undefined,
    slackBotToken: undefined,
    slackChannelId: undefined,
    slackSigningSecret: undefined,
    pollIntervalMinutes: 1,
    backfillIntervalMinutes: 30,
    dbPath: ":memory:",
    minTier: undefined,
    logLevel: "error",
    port: 3000,
    anthropicApiKey: undefined,
    agentModel: "claude-sonnet-4-6",
    agentHistoryWeeks: 8,
  };
}

/** Silent logger for tests. */
function makeSilentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

describe("scheduler shutdown", () => {
  const originalFetch = globalThis.fetch;

  function mockFetch(fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
    const mocked = Object.assign(mock(fn), { preconnect: mock((_url: string | URL) => {}) });
    globalThis.fetch = mocked;
  }

  afterEach(() => {
    resetShutdown();
    globalThis.fetch = originalFetch;
  });

  test("requestShutdown during execution causes startScheduler to exit", async () => {
    // Mock fetch so the scheduler's fetchSchedule call triggers shutdown
    // before any real work happens.
    mockFetch(() => {
      // Signal shutdown while the scheduler is awaiting the schedule fetch.
      requestShutdown();
      return Promise.resolve(
        new Response(JSON.stringify({ dates: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const logger = makeSilentLogger();
    await startScheduler({
      config: makeTestConfig(),
      db: {} as Database,
      logger,
    });

    // If we got here without timing out, the shutdown flag worked.
    expect(logger.info).toHaveBeenCalled();
  });

  test("resetShutdown clears the shutdown flag so it can be re-set", () => {
    requestShutdown();
    resetShutdown();

    mockFetch(() => {
      requestShutdown();
      return Promise.resolve(
        new Response(JSON.stringify({ dates: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const logger = makeSilentLogger();
    const promise = startScheduler({
      config: makeTestConfig(),
      db: {} as Database,
      logger,
    });

    expect(promise).resolves.toBeUndefined();
  });
});
