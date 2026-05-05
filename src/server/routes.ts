/**
 * HTTP server module for the janitor-bot REST API.
 *
 * Uses Bun.serve() to expose endpoints for querying stored outfield assist
 * plays, aggregated stats, and health/scheduler status. All responses are
 * JSON with CORS headers for cross-origin access.
 *
 * Phase 3 implementation.
 */

import type { Database } from "bun:sqlite";
import type { Server } from "bun";

/** Server instance type without WebSocket data. */
type HttpServer = Server<undefined>;
import type { Logger } from "../logger";
import type { Tier } from "../types/play";
import type { PlayFilters } from "../storage/db";
import {
  queryPlays,
  queryPlayCount,
  queryPlayById,
  queryPlayStats,
  getDbStats,
} from "../storage/db";
import type { SchedulerStatus } from "../daemon/scheduler";
import { LANDING_PAGE_HTML } from "./landing";
import {
  verifySlackSignature,
  isDuplicateEvent,
  dispatchEvent,
  type SlackEventEnvelope,
} from "../notifications/slack-events";
import type { SlackClientConfig } from "../notifications/slack-client";

/** Dependencies injected into the server factory. */
export interface ServerDeps {
  db: Database;
  dbPath: string;
  logger: Logger;
  port: number;
  getSchedulerStatus: () => SchedulerStatus;
  /** Signing secret for verifying Slack Events API requests. Optional —
   *  when unset, the /slack/events endpoint returns 500 (fail closed). */
  slackSigningSecret?: string;
  /** Slack client config used by the dispatcher to call users.info. */
  slackConfig?: SlackClientConfig;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Builds a JSON Response with CORS headers and Content-Type pre-set.
 *
 * @param data    - Serializable payload
 * @param status  - HTTP status code (default 200)
 * @param headers - Extra headers merged on top of defaults
 */
function jsonResponse(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

/** Returns today's date as YYYY-MM-DD in local time. */
function todayLocal(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TIERS = new Set<string>(["high", "medium", "low"]);
const VALID_POSITIONS = new Set<string>(["LF", "CF", "RF"]);
const VALID_BASES = new Set<string>(["2B", "3B", "Home"]);

/**
 * Parses a string as a non-negative integer.
 * Returns null when the value is not a valid non-negative integer.
 */
function parseNonNegativeInt(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Extracts and validates PlayFilters from URL search params.
 * Returns either the parsed filters or an error string.
 */
function parsePlayFilters(
  params: URLSearchParams,
  forcedDate?: string,
): PlayFilters | string {
  const filters: PlayFilters = {};

  if (forcedDate) {
    filters.date = forcedDate;
  } else if (params.has("date")) {
    const date = params.get("date")!;
    if (!DATE_PATTERN.test(date)) {
      return "date must be in YYYY-MM-DD format";
    }
    filters.date = date;
  }

  if (params.has("from")) {
    const from = params.get("from")!;
    if (!DATE_PATTERN.test(from)) {
      return "from must be in YYYY-MM-DD format";
    }
    filters.from = from;
  }

  if (params.has("to")) {
    const to = params.get("to")!;
    if (!DATE_PATTERN.test(to)) {
      return "to must be in YYYY-MM-DD format";
    }
    filters.to = to;
  }

  // L2: Reject conflicting date + from/to
  if ((forcedDate || filters.date) && (filters.from || filters.to)) {
    return "Cannot combine date with from/to range filters";
  }

  // Reject inverted date ranges
  if (filters.from && filters.to && filters.from > filters.to) {
    return "from must not be after to";
  }
  if (params.has("team")) filters.team = params.get("team")!;
  if (params.has("fielder")) filters.fielder = params.get("fielder")!;

  if (params.has("tier")) {
    const tier = params.get("tier")!;
    if (!VALID_TIERS.has(tier)) {
      return "tier must be one of: high, medium, low";
    }
    filters.tier = tier as Tier;
  }

  if (params.has("position")) {
    const position = params.get("position")!;
    if (!VALID_POSITIONS.has(position)) {
      return "position must be one of: LF, CF, RF";
    }
    filters.position = position;
  }

  if (params.has("base")) {
    const base = params.get("base")!;
    if (!VALID_BASES.has(base)) {
      return "base must be one of: 2B, 3B, Home";
    }
    filters.base = base;
  }

  if (params.has("limit")) {
    const limit = parseNonNegativeInt(params.get("limit")!);
    if (limit === null) return "limit must be a non-negative integer";
    filters.limit = Math.min(limit, 200);
  }

  if (params.has("offset")) {
    const offset = parseNonNegativeInt(params.get("offset")!);
    if (offset === null) return "offset must be a non-negative integer";
    if (offset > 10000) return "offset must not exceed 10000";
    filters.offset = offset;
  }

  return filters;
}

/** Known route patterns for 405 detection. */
const KNOWN_ROUTES: Array<RegExp | string> = [
  "/",
  "/plays",
  "/plays/today",
  /^\/plays\/\d+$/,
  "/stats",
  "/health",
];

/**
 * Returns true when the pathname matches one of the API's known routes.
 * Used to distinguish 405 (wrong method on valid route) from 404.
 */
function matchesKnownRoute(pathname: string): boolean {
  return KNOWN_ROUTES.some((route) =>
    typeof route === "string" ? route === pathname : route.test(pathname),
  );
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

interface HandlerContext {
  db: Database;
  dbPath: string;
  getSchedulerStatus: () => SchedulerStatus;
  logger: Logger;
  slackSigningSecret?: string;
  slackConfig?: SlackClientConfig;
}

/**
 * GET /plays and GET /plays/today
 *
 * Returns paginated plays matching the provided filters.
 */
function handlePlays(
  ctx: HandlerContext,
  params: URLSearchParams,
  forcedDate?: string,
): Response {
  const filtersOrError = parsePlayFilters(params, forcedDate);
  if (typeof filtersOrError === "string") {
    return jsonResponse({ error: filtersOrError }, 400);
  }

  const filters = filtersOrError;
  const plays = queryPlays(ctx.db, filters);
  const total = queryPlayCount(ctx.db, filters);
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  return jsonResponse({ plays, total, limit, offset });
}

/** GET /plays/:id */
function handlePlayById(ctx: HandlerContext, idSegment: string): Response {
  const id = parseNonNegativeInt(idSegment);
  if (id === null) {
    return jsonResponse({ error: "id must be a valid integer" }, 400);
  }

  const play = queryPlayById(ctx.db, id);
  if (!play) {
    return jsonResponse({ error: "Play not found" }, 404);
  }

  return jsonResponse(play);
}

/** GET /stats */
function handleStats(ctx: HandlerContext, params: URLSearchParams): Response {
  const from = params.get("from") ?? undefined;
  const to = params.get("to") ?? undefined;

  if (from && !DATE_PATTERN.test(from)) {
    return jsonResponse({ error: "from must be in YYYY-MM-DD format" }, 400);
  }
  if (to && !DATE_PATTERN.test(to)) {
    return jsonResponse({ error: "to must be in YYYY-MM-DD format" }, 400);
  }
  if (from && to && from > to) {
    return jsonResponse({ error: "from must not be after to" }, 400);
  }

  const stats = queryPlayStats(ctx.db, from, to);
  return jsonResponse(stats);
}

/** GET /health */
function handleHealth(ctx: HandlerContext): Response {
  const database = getDbStats(ctx.db, ctx.dbPath);
  const scheduler = ctx.getSchedulerStatus();
  return jsonResponse({ status: "ok", database, scheduler });
}

/**
 * POST /slack/events
 *
 * Verifies Slack's request signature, dedupes by event_id, acks 200, and
 * dispatches the envelope to the vote handler asynchronously so we always
 * stay inside Slack's 3-second response window.
 *
 * Returns 500 when SLACK_SIGNING_SECRET is not configured (fail closed),
 * 401 on signature verify failure, and 200 on every other path so Slack
 * never retries a successfully-received event.
 */
async function handleSlackEvents(
  ctx: HandlerContext,
  req: Request,
): Promise<Response> {
  if (!ctx.slackSigningSecret) {
    ctx.logger.error("slack events received but signing secret not configured");
    return jsonResponse({ error: "signing secret not configured" }, 500);
  }

  const rawBody = await req.text();
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");

  if (!verifySlackSignature(ctx.slackSigningSecret, ts, sig, rawBody)) {
    return jsonResponse({ error: "invalid signature" }, 401);
  }

  let envelope: SlackEventEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return jsonResponse({ error: "invalid json" }, 400);
  }

  if (envelope.type === "url_verification") {
    return jsonResponse({ challenge: envelope.challenge });
  }

  if (envelope.event_id && isDuplicateEvent(envelope.event_id)) {
    return new Response("", { status: 200 });
  }

  // Ack first, dispatch after — Slack's 3-second timeout starts at receipt.
  if (ctx.slackConfig) {
    const dispatchCtx = {
      db: ctx.db,
      logger: ctx.logger,
      slackConfig: ctx.slackConfig,
    };
    queueMicrotask(() => {
      dispatchEvent(envelope, dispatchCtx).catch((err) => {
        ctx.logger.error("dispatch microtask threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  return new Response("", { status: 200 });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Creates and starts the HTTP server on the given port.
 *
 * Routes are matched in order:
 * 1. OPTIONS on any path (CORS preflight)
 * 2. GET /plays/today
 * 3. GET /plays/:id (numeric id)
 * 4. GET /plays
 * 5. GET /stats
 * 6. GET /health
 * 7. Everything else -> 404
 *
 * @param deps - Injected dependencies (database, logger, port, scheduler status getter)
 * @returns The running Bun Server instance
 */
export function startServer(deps: ServerDeps): HttpServer {
  const {
    db,
    dbPath,
    logger,
    port,
    getSchedulerStatus,
    slackSigningSecret,
    slackConfig,
  } = deps;

  const ctx: HandlerContext = {
    db,
    dbPath,
    getSchedulerStatus,
    logger,
    slackSigningSecret,
    slackConfig,
  };

  const server = Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const start = performance.now();
      const url = new URL(req.url);
      const { pathname } = url;

      let response: Response;

      try {
        // CORS preflight
        if (req.method === "OPTIONS") {
          response = new Response(null, { status: 204, headers: CORS_HEADERS });
          logRequest(logger, req.method, pathname, response.status, start);
          return response;
        }

        // POST /slack/events (handled before the GET-only guard)
        if (req.method === "POST" && pathname === "/slack/events") {
          response = await handleSlackEvents(ctx, req);
          logRequest(logger, req.method, pathname, response.status, start);
          return response;
        }

        if (req.method !== "GET") {
          if (matchesKnownRoute(pathname)) {
            response = jsonResponse(
              { error: "Method not allowed" },
              405,
              { Allow: "GET, OPTIONS" },
            );
          } else {
            response = jsonResponse({ error: "Not found" }, 404);
          }
          logRequest(logger, req.method, pathname, response.status, start);
          return response;
        }

        // GET /
        if (pathname === "/") {
          response = new Response(LANDING_PAGE_HTML, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              ...CORS_HEADERS,
            },
          });
          logRequest(logger, req.method, pathname, response.status, start);
          return response;
        }

        // GET /plays/today
        if (pathname === "/plays/today") {
          response = handlePlays(ctx, url.searchParams, todayLocal());
          logRequest(logger, req.method, pathname, response.status, start);
          return response;
        }

        // GET /plays/:id (numeric segment after /plays/)
        const playByIdMatch = pathname.match(/^\/plays\/(\d+)$/);
        if (playByIdMatch) {
          response = handlePlayById(ctx, playByIdMatch[1]);
          logRequest(logger, req.method, pathname, response.status, start);
          return response;
        }

        // GET /plays
        if (pathname === "/plays") {
          response = handlePlays(ctx, url.searchParams);
          logRequest(logger, req.method, pathname, response.status, start);
          return response;
        }

        // GET /stats
        if (pathname === "/stats") {
          response = handleStats(ctx, url.searchParams);
          logRequest(logger, req.method, pathname, response.status, start);
          return response;
        }

        // GET /health
        if (pathname === "/health") {
          response = handleHealth(ctx);
          logRequest(logger, req.method, pathname, response.status, start);
          return response;
        }

        // Fallback
        response = jsonResponse({ error: "Not found" }, 404);
        logRequest(logger, req.method, pathname, response.status, start);
        return response;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("unhandled error in request handler", {
          method: req.method,
          path: pathname,
          error: message,
        });
        response = jsonResponse({ error: "Internal server error" }, 500);
        logRequest(logger, req.method, pathname, response.status, start);
        return response;
      }
    },
  });

  logger.info("HTTP server started", { port: server.port });
  return server;
}

/**
 * Logs a completed request at debug level with method, path, status, and
 * duration in milliseconds.
 */
function logRequest(
  logger: Logger,
  method: string,
  path: string,
  status: number,
  startMs: number,
): void {
  const durationMs = Math.round((performance.now() - startMs) * 100) / 100;
  logger.debug("request", { method, path, status, durationMs });
}
