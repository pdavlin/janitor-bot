/**
 * Tests for the structured JSON logger.
 *
 * Mocks console.log and console.error to capture output, then parses
 * the JSON to verify structure and level filtering.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { createLogger } from "../logger";
import type { LogLevel } from "../logger";

describe("createLogger", () => {
  const originalLog = console.log;
  const originalError = console.error;

  let logCalls: string[];
  let errorCalls: string[];

  beforeEach(() => {
    logCalls = [];
    errorCalls = [];
    console.log = mock((...args: unknown[]) => {
      logCalls.push(String(args[0]));
    });
    console.error = mock((...args: unknown[]) => {
      errorCalls.push(String(args[0]));
    });
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  /** Helper to get all captured output lines as parsed JSON. */
  function allOutput(): Record<string, unknown>[] {
    return [...logCalls, ...errorCalls].map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
  }

  /** Calls all four log methods with predictable messages. */
  function emitAllLevels(level: LogLevel): void {
    const logger = createLogger(level);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
  }

  // -------------------------------------------------------------------------
  // Level filtering
  // -------------------------------------------------------------------------

  test("debug level emits all four levels", () => {
    emitAllLevels("debug");
    const levels = allOutput().map((o) => o.level);
    expect(levels).toEqual(["debug", "info", "warn", "error"]);
  });

  test("info level suppresses debug", () => {
    emitAllLevels("info");
    const levels = allOutput().map((o) => o.level);
    expect(levels).toEqual(["info", "warn", "error"]);
  });

  test("warn level suppresses debug and info", () => {
    emitAllLevels("warn");
    const levels = allOutput().map((o) => o.level);
    expect(levels).toEqual(["warn", "error"]);
  });

  test("error level suppresses debug, info, and warn", () => {
    emitAllLevels("error");
    const levels = allOutput().map((o) => o.level);
    expect(levels).toEqual(["error"]);
  });

  // -------------------------------------------------------------------------
  // Output routing
  // -------------------------------------------------------------------------

  test("debug and info write to console.log", () => {
    const logger = createLogger("debug");
    logger.debug("d");
    logger.info("i");

    expect(logCalls).toHaveLength(2);
    expect(errorCalls).toHaveLength(0);
  });

  test("warn and error write to console.error", () => {
    const logger = createLogger("debug");
    logger.warn("w");
    logger.error("e");

    expect(logCalls).toHaveLength(0);
    expect(errorCalls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // JSON structure
  // -------------------------------------------------------------------------

  test("output is valid JSON with timestamp, level, and message", () => {
    const logger = createLogger("info");
    logger.info("hello");

    expect(logCalls).toHaveLength(1);
    const parsed = JSON.parse(logCalls[0]) as Record<string, unknown>;

    expect(parsed).toHaveProperty("timestamp");
    expect(parsed).toHaveProperty("level", "info");
    expect(parsed).toHaveProperty("message", "hello");
    expect(typeof parsed.timestamp).toBe("string");
    // Should be a valid ISO date
    expect(Number.isNaN(Date.parse(parsed.timestamp as string))).toBe(false);
  });

  test("extra data fields are spread into the JSON output", () => {
    const logger = createLogger("info");
    logger.info("request", { method: "GET", path: "/api", statusCode: 200 });

    const parsed = JSON.parse(logCalls[0]) as Record<string, unknown>;
    expect(parsed.method).toBe("GET");
    expect(parsed.path).toBe("/api");
    expect(parsed.statusCode).toBe(200);
    // Core fields still present
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("request");
  });
});
