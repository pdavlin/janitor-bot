/**
 * CLI entry point for the janitor-bot self-scheduling daemon.
 *
 * Loads configuration, initializes the database, and starts a polling
 * scheduler loop that periodically scans for new outfield assists.
 *
 * Usage:
 *   bun run src/cli/daemon.ts
 *
 * Environment:
 *   DB_PATH              - path to SQLite database file (default: ./janitor-throws.db)
 *   POLL_INTERVAL_MINUTES - minutes between scan cycles (default: 30)
 *   SLACK_WEBHOOK_URL    - Slack incoming webhook URL for notifications (optional)
 *   MIN_TIER             - minimum play tier to report: high, medium, low (optional)
 *   LOG_LEVEL            - logging verbosity: debug, info, warn, error (default: info)
 */

import { loadConfig } from "../config";
import { createLogger } from "../logger";
import { createDatabase } from "../storage/db";
import { startScheduler, requestShutdown, getSchedulerStatus } from "../daemon/scheduler";
import { startServer } from "../server/routes";

/**
 * Main daemon process. Wires together configuration, logging, storage,
 * and the scheduler loop, then blocks until the scheduler exits.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info("janitor-bot daemon starting", {
    dbPath: config.dbPath,
    pollIntervalMinutes: config.pollIntervalMinutes,
    slackConfigured: config.slackWebhookUrl !== undefined,
    minTier: config.minTier ?? "all",
    logLevel: config.logLevel,
    port: config.port,
  });

  const db = createDatabase(config.dbPath);

  const server = startServer({
    db,
    dbPath: config.dbPath,
    logger,
    port: config.port,
    getSchedulerStatus,
  });

  logger.info("http server started", { port: config.port });

  // Graceful shutdown handling (FR-2.16)
  let shuttingDown = false;

  const handleSignal = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("received shutdown signal, finishing current work", { signal });
    requestShutdown();
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    await startScheduler({ config, db, logger });
  } finally {
    server.stop();
    db.close();
    logger.info("janitor-bot daemon stopped");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
