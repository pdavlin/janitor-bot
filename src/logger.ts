/**
 * Structured JSON logging module for janitor-bot.
 *
 * Writes one JSON object per log call to stdout (debug/info) or stderr (warn/error).
 * Supports configurable minimum log level filtering.
 *
 * @example
 * ```ts
 * const log = createLogger("info");
 * log.info("server started", { port: 3000 });
 * // => {"timestamp":"2026-03-12T00:00:00.000Z","level":"info","message":"server started","port":3000}
 * ```
 */

/** Supported log levels ordered from most to least verbose. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured logger with one method per log level. */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Numeric priority for each level. Higher number = more severe. */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Formats a structured log entry as a single JSON line.
 *
 * @param level - The severity level of this entry
 * @param message - Human-readable log message
 * @param data - Optional key-value pairs merged into the log object
 * @returns A JSON string with timestamp, level, message, and any extra fields
 */
function formatEntry(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  });
}

/**
 * Creates a structured JSON logger that filters output by minimum log level.
 *
 * Log level filtering works as a threshold: setting the level to "warn" suppresses
 * debug and info messages while allowing warn and error through.
 *
 * - debug/info entries write to stdout via console.log
 * - warn/error entries write to stderr via console.error
 *
 * @param level - Minimum log level to emit. Messages below this threshold are silently dropped.
 * @returns A Logger object with debug, info, warn, and error methods
 */
export function createLogger(level: LogLevel): Logger {
  const threshold = LEVEL_PRIORITY[level];

  function shouldLog(target: LogLevel): boolean {
    return LEVEL_PRIORITY[target] >= threshold;
  }

  return {
    debug(message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("debug")) return;
      console.log(formatEntry("debug", message, data));
    },

    info(message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("info")) return;
      console.log(formatEntry("info", message, data));
    },

    warn(message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("warn")) return;
      console.error(formatEntry("warn", message, data));
    },

    error(message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("error")) return;
      console.error(formatEntry("error", message, data));
    },
  };
}
