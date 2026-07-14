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
  queryWeeklyCounts,
  queryTierCounts,
  queryTargetBaseCounts,
  queryDirectRelayByBase,
  queryArmLeaderboard,
  queryTeamsMostBurned,
  queryRecentHighTierPlays,
  queryDistinctTeams,
  queryVoteEngagement,
  queryMostLovedPlays,
  queryFlaggedSnapshots,
  queryFetchStatusCounts,
  queryRematchDecisionCounts,
  queryPipelineTotals,
  queryThrowLanes,
  queryCannonRankings,
  queryMeasuredThrows,
  queryVelocitySummary,
  velocitySummaryFromThrows,
  queryFielderProfile,
} from "../storage/db";
import type { SchedulerStatus } from "../daemon/scheduler";
import { renderHomePage } from "./pages/home";
import {
  renderHighlightsPage,
  HIGHLIGHTS_PAGE_SIZE,
  HIGHLIGHTS_MAX_OFFSET,
  type HighlightsFilters,
} from "./pages/highlights";
import { renderSeasonPage } from "./pages/season";
import { renderAboutPage } from "./pages/about";
import { renderOpsPage } from "./pages/ops";
import { renderErrorPage, renderNotFoundPage } from "./pages/error";
import { renderFielderPage } from "./pages/fielder";
import { renderPlayPage } from "./pages/play";
import { renderShareCardSvg } from "./pages/share-card";
import { BASE_OPTIONS, POSITION_OPTIONS, TIER_OPTIONS } from "./filter-options";
import { serveTeamAsset } from "./team-assets";
import {
  verifySlackSignature,
  isDuplicateEvent,
  dispatchEvent,
  type SlackEventEnvelope,
  type RematchDispatchConfig,
  type AngleDispatchConfig,
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
  /** Re-match (:repeat:) reaction handler config. Omit to disable. */
  rematch?: RematchDispatchConfig;
  /** Alternate-angle (:movie_camera:) reaction handler config. Omit to disable. */
  angle?: AngleDispatchConfig;
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

/** Builds an HTML Response with CORS headers and Content-Type pre-set. */
function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...CORS_HEADERS,
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
/** MLB team abbreviation shape (2-3 uppercase letters, e.g. LAD, KC). */
const TEAM_ABBR_PATTERN = /^[A-Z]{2,3}$/;
const VALID_TIERS = new Set<string>(TIER_OPTIONS);
const VALID_POSITIONS = new Set<string>(POSITION_OPTIONS);
const VALID_BASES = new Set<string>(BASE_OPTIONS);

/**
 * Parses a string as a non-negative integer.
 * Returns null when the value is not a valid non-negative integer.
 */
function parseNonNegativeInt(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Type guard narrowing a validated tier string to the Tier union. */
function isTier(value: string): value is Tier {
  return VALID_TIERS.has(value);
}

/** The filter fields shared by the JSON API and the HTML gallery. */
type SharedFilterName = "tier" | "team" | "position" | "base";

/**
 * Spec for one shared filter field. `canonicalize` maps the raw query
 * value to the stored filter value, or null when invalid; the policy
 * decides what invalid means (see parseSharedFilters).
 *
 * Team is the one field whose canonical form is policy-dependent: the
 * JSON API passes it through untouched (exact-match semantics), while the
 * gallery uppercases and shape-checks it so the form never carries an
 * invisible filter it can't render (the highlights handler additionally
 * checks the value against the DB's distinct teams).
 */
interface SharedFilterSpec {
  name: SharedFilterName;
  /** 400 error body for the strict policy. */
  invalidMessage: string;
  canonicalize: (raw: string, strict: boolean) => string | null;
}

const SHARED_FILTER_SPECS: readonly SharedFilterSpec[] = [
  {
    name: "tier",
    invalidMessage: `tier must be one of: ${TIER_OPTIONS.join(", ")}`,
    canonicalize: (raw) => (VALID_TIERS.has(raw) ? raw : null),
  },
  {
    // Never invalid under the strict policy, so invalidMessage can't fire.
    name: "team",
    invalidMessage: "team is invalid",
    canonicalize: (raw, strict) => {
      if (strict) return raw;
      const upper = raw.toUpperCase();
      return TEAM_ABBR_PATTERN.test(upper) ? upper : null;
    },
  },
  {
    name: "position",
    invalidMessage: `position must be one of: ${POSITION_OPTIONS.join(", ")}`,
    canonicalize: (raw) => (VALID_POSITIONS.has(raw) ? raw : null),
  },
  {
    name: "base",
    invalidMessage: `base must be one of: ${BASE_OPTIONS.join(", ")}`,
    canonicalize: (raw) => (VALID_BASES.has(raw) ? raw : null),
  },
];

/**
 * Parses the shared tier/team/position/base fields off the query string.
 * One spec walk serves both filter parsers; only the failure policy
 * differs:
 *
 *   - strict (JSON API): an invalid value returns that field's 400 error
 *     string, and empty-string values are validated like any other.
 *   - lenient (gallery form): empty or invalid values are treated as
 *     unset, since the page's own form only emits valid values.
 */
function parseSharedFilters(
  params: URLSearchParams,
  policy: "strict",
): HighlightsFilters | string;
function parseSharedFilters(
  params: URLSearchParams,
  policy: "lenient",
): HighlightsFilters;
function parseSharedFilters(
  params: URLSearchParams,
  policy: "strict" | "lenient",
): HighlightsFilters | string {
  const strict = policy === "strict";
  const filters: HighlightsFilters = {};

  for (const spec of SHARED_FILTER_SPECS) {
    const raw = params.get(spec.name);
    if (raw === null) continue;
    if (!strict && raw === "") continue;

    const value = spec.canonicalize(raw, strict);
    if (value === null) {
      if (strict) return spec.invalidMessage;
      continue;
    }

    if (spec.name === "tier") {
      // canonicalize guarantees VALID_TIERS membership; narrow for the type.
      if (isTier(value)) filters.tier = value;
    } else {
      filters[spec.name] = value;
    }
  }

  return filters;
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

  const sharedOrError = parseSharedFilters(params, "strict");
  if (typeof sharedOrError === "string") return sharedOrError;
  Object.assign(filters, sharedOrError);

  if (params.has("fielder")) filters.fielder = params.get("fielder")!;

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

/**
 * Extracts HighlightsFilters from URL search params for the HTML gallery:
 * the shared field specs under the lenient policy.
 */
function parseHighlightsFilters(params: URLSearchParams): HighlightsFilters {
  return parseSharedFilters(params, "lenient");
}

/**
 * Parses the highlights ?offset param, clamped to the page-aligned maximum
 * (HIGHLIGHTS_MAX_OFFSET); invalid or missing -> 0. Page alignment keeps the
 * clamp on a real page so the pager's older link disappears at the boundary
 * instead of looping back to the same page.
 */
function parseHighlightsOffset(params: URLSearchParams): number {
  const raw = params.get("offset");
  if (raw === null) return 0;
  const offset = parseNonNegativeInt(raw);
  if (offset === null) return 0;
  return Math.min(offset, HIGHLIGHTS_MAX_OFFSET);
}

/** Matches GET /assets/teams/:abbr.png. */
const TEAM_ASSET_ROUTE = /^\/assets\/teams\/([A-Za-z]{1,5})\.png$/;

/**
 * Matches GET /plays/:id (numeric segment after /plays/) — the JSON API.
 * Not to be confused with the singular /play/:id HTML permalink below.
 */
const PLAY_BY_ID_ROUTE = /^\/plays\/(\d+)$/;

/** Matches GET /fielders/:id — the HTML fielder profile page. */
const FIELDER_PAGE_ROUTE = /^\/fielders\/(\d+)$/;

/**
 * Matches GET /play/:id — the HTML play permalink page. Singular /play is
 * deliberate: plural /plays/:id stays the JSON API endpoint.
 */
const PLAY_PAGE_ROUTE = /^\/play\/(\d+)$/;

/** Matches GET /play/:id/card.svg — the standalone share-card image. */
const PLAY_CARD_SVG_ROUTE = /^\/play\/(\d+)\/card\.svg$/;

/** Themed 500 document, built once (DB-free) and reused for HTML errors. */
const ERROR_PAGE_HTML = renderErrorPage();

/** Themed 404 document for the HTML page routes, built once (DB-free). */
const NOT_FOUND_PAGE_HTML = renderNotFoundPage();

/**
 * Cache lifetime for the share-card SVG. Shorter than the team assets'
 * immutable week because a card's content can still change after first
 * serve (velocity backfill, re-match tier swaps).
 */
const CARD_CACHE_CONTROL = "public, max-age=86400";

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
  rematch?: RematchDispatchConfig;
  angle?: AngleDispatchConfig;
}

/**
 * GET /
 *
 * Home page: headline stat tiles, the three most recent high-tier plays
 * with video, and the about blurb.
 */
function handleHomePage(ctx: HandlerContext): Response {
  const dbStats = getDbStats(ctx.db, ctx.dbPath);
  return htmlResponse(
    renderHomePage({
      totalPlays: dbStats.totalPlays,
      highTierCount: queryPlayCount(ctx.db, { tier: "high" }),
      oldestPlay: dbStats.oldestPlay,
      newestPlay: dbStats.newestPlay,
      recentPlays: queryRecentHighTierPlays(ctx.db, 3),
    }),
  );
}

/**
 * GET /highlights
 *
 * Gallery page with server-side tier/team/position/base filters and
 * offset paging.
 */
function handleHighlightsPage(
  ctx: HandlerContext,
  params: URLSearchParams,
): Response {
  const filters = parseHighlightsFilters(params);
  const offset = parseHighlightsOffset(params);
  const teams = queryDistinctTeams(ctx.db);
  // Drop a well-formed but unknown team so it never becomes an invisible
  // filter the select can't display as the current value.
  if (filters.team !== undefined && !teams.includes(filters.team)) {
    delete filters.team;
  }
  const plays = queryPlays(ctx.db, {
    ...filters,
    limit: HIGHLIGHTS_PAGE_SIZE,
    offset,
  });
  const total = queryPlayCount(ctx.db, filters);
  return htmlResponse(
    renderHighlightsPage({
      plays,
      total,
      offset,
      filters,
      teams,
    }),
  );
}

/**
 * GET /season
 *
 * Season stats page: four charts, the arm leaderboard, and the
 * teams-most-burned list, computed from the DB at request time. The
 * velocity summary is derived from the measured-throw list already
 * fetched for the beeswarm, not queried a second time.
 */
function handleSeasonPage(ctx: HandlerContext): Response {
  const dbStats = getDbStats(ctx.db, ctx.dbPath);
  const throws = queryMeasuredThrows(ctx.db);
  return htmlResponse(
    renderSeasonPage({
      totalPlays: dbStats.totalPlays,
      oldestPlay: dbStats.oldestPlay,
      newestPlay: dbStats.newestPlay,
      weekly: queryWeeklyCounts(ctx.db),
      tiers: queryTierCounts(ctx.db),
      bases: queryTargetBaseCounts(ctx.db),
      mix: queryDirectRelayByBase(ctx.db),
      leaders: queryArmLeaderboard(ctx.db),
      teamsBurned: queryTeamsMostBurned(ctx.db),
      lanes: queryThrowLanes(ctx.db),
      cannons: queryCannonRankings(ctx.db),
      throws,
      velocity: velocitySummaryFromThrows(throws, dbStats.totalPlays),
    }),
  );
}

/**
 * GET /fielders/:id
 *
 * Fielder profile page. Unknown or playless ids return the themed 404.
 */
function handleFielderPage(ctx: HandlerContext, idSegment: string): Response {
  const id = parseNonNegativeInt(idSegment);
  const profile = id === null ? null : queryFielderProfile(ctx.db, id);
  if (id === null || !profile) {
    return htmlResponse(NOT_FOUND_PAGE_HTML, 404);
  }
  return htmlResponse(
    renderFielderPage({
      profile,
      lanes: queryThrowLanes(ctx.db, id),
      velocities: queryMeasuredThrows(ctx.db, id).map((t) => t.velocity),
      league: queryVelocitySummary(ctx.db),
      teamsBurned: queryTeamsMostBurned(ctx.db, 10, id),
      recentPlays: queryPlays(ctx.db, { fielderId: id, limit: 3 }),
    }),
  );
}

/**
 * GET /play/:id
 *
 * Play permalink page (HTML; the JSON API stays at plural /plays/:id).
 * Unknown ids return the themed 404.
 */
function handlePlayPage(ctx: HandlerContext, idSegment: string): Response {
  const id = parseNonNegativeInt(idSegment);
  const play = id === null ? null : queryPlayById(ctx.db, id);
  if (!play) {
    return htmlResponse(NOT_FOUND_PAGE_HTML, 404);
  }
  return htmlResponse(renderPlayPage(play));
}

/**
 * GET /play/:id/card.svg
 *
 * The standalone 1200×630 share-card image referenced by the permalink's
 * og:image. Served with CORS and a one-day cache (the card can change
 * when a velocity backfill or re-match lands).
 */
function handlePlayCardSvg(ctx: HandlerContext, idSegment: string): Response {
  const id = parseNonNegativeInt(idSegment);
  const play = id === null ? null : queryPlayById(ctx.db, id);
  if (!play) {
    return new Response("Not found", { status: 404, headers: { ...CORS_HEADERS } });
  }
  return new Response(renderShareCardSvg(play), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": CARD_CACHE_CONTROL,
    },
  });
}

/**
 * GET /ops
 *
 * Internal dashboard (public, unlinked from the nav): vote engagement and
 * pipeline health, computed from the DB at request time.
 */
function handleOpsPage(ctx: HandlerContext): Response {
  const dbStats = getDbStats(ctx.db, ctx.dbPath);
  return htmlResponse(
    renderOpsPage({
      engagement: queryVoteEngagement(ctx.db),
      loved: queryMostLovedPlays(ctx.db),
      flagged: queryFlaggedSnapshots(ctx.db),
      fetchStatuses: queryFetchStatusCounts(ctx.db),
      rematchDecisions: queryRematchDecisionCounts(ctx.db),
      totals: queryPipelineTotals(ctx.db),
      tiers: queryTierCounts(ctx.db),
      oldestPlay: dbStats.oldestPlay,
      newestPlay: dbStats.newestPlay,
    }),
  );
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
      rematch: ctx.rematch,
      angle: ctx.angle,
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
// Route table
// ---------------------------------------------------------------------------

/**
 * One GET route: an exact path or a pattern, its handler, and (for HTML
 * pages) the flag that routes unhandled errors to the themed 500 page.
 * Pattern handlers receive the pathname match so they can read capture
 * groups.
 */
type GetRoute =
  | {
      path: string;
      /** True for HTML pages: an unhandled error returns the themed 500. */
      html?: true;
      handle: (
        ctx: HandlerContext,
        params: URLSearchParams,
      ) => Response | Promise<Response>;
    }
  | {
      pattern: RegExp;
      /** True for HTML pages: an unhandled error returns the themed 500. */
      html?: true;
      handle: (
        ctx: HandlerContext,
        params: URLSearchParams,
        match: RegExpMatchArray,
      ) => Response | Promise<Response>;
    };

/**
 * The GET route table, in match order (exact paths first, then patterns,
 * mirroring the precedence documented on startServer). One table drives
 * dispatch, the 405-vs-404 distinction for non-GET methods, and the
 * HTML-vs-JSON error shape, so a route can't be known to one and not
 * another.
 */
const GET_ROUTES: readonly GetRoute[] = [
  { path: "/", html: true, handle: handleHomePage },
  { path: "/highlights", html: true, handle: handleHighlightsPage },
  { path: "/season", html: true, handle: handleSeasonPage },
  { path: "/about", html: true, handle: () => htmlResponse(renderAboutPage()) },
  { path: "/ops", html: true, handle: handleOpsPage },
  {
    pattern: FIELDER_PAGE_ROUTE,
    html: true,
    handle: (ctx, _params, match) => handleFielderPage(ctx, match[1]),
  },
  {
    pattern: PLAY_CARD_SVG_ROUTE,
    handle: (ctx, _params, match) => handlePlayCardSvg(ctx, match[1]),
  },
  {
    pattern: PLAY_PAGE_ROUTE,
    html: true,
    handle: (ctx, _params, match) => handlePlayPage(ctx, match[1]),
  },
  {
    pattern: TEAM_ASSET_ROUTE,
    handle: (_ctx, _params, match) => serveTeamAsset(match[1], CORS_HEADERS),
  },
  {
    path: "/plays/today",
    handle: (ctx: HandlerContext, params: URLSearchParams) =>
      handlePlays(ctx, params, todayLocal()),
  },
  {
    pattern: PLAY_BY_ID_ROUTE,
    handle: (ctx, _params, match) => handlePlayById(ctx, match[1]),
  },
  { path: "/plays", handle: handlePlays },
  { path: "/stats", handle: handleStats },
  { path: "/health", handle: handleHealth },
];

/**
 * Returns true when the pathname matches one of the API's known routes.
 * Used to distinguish 405 (wrong method on valid route) from 404.
 */
function matchesKnownRoute(pathname: string): boolean {
  return GET_ROUTES.some((route) =>
    "path" in route ? route.path === pathname : route.pattern.test(pathname),
  );
}

/** HTML page paths; an unhandled error on these returns a themed 500, not JSON. */
const HTML_ROUTE_PATHS = new Set<string>(
  GET_ROUTES.flatMap((route) =>
    "path" in route && route.html ? [route.path] : [],
  ),
);

/** Patterns of the HTML page routes (fielder profiles, play permalinks). */
const HTML_ROUTE_PATTERNS: readonly RegExp[] = GET_ROUTES.flatMap((route) =>
  "pattern" in route && route.html ? [route.pattern] : [],
);

/** True when the pathname belongs to an HTML page route (exact or pattern). */
function isHtmlRoute(pathname: string): boolean {
  return (
    HTML_ROUTE_PATHS.has(pathname) ||
    HTML_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname))
  );
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Creates and starts the HTTP server on the given port.
 *
 * Routes are matched in order:
 * 1. OPTIONS on any path (CORS preflight)
 * 2. POST /slack/events
 * 3. GET routes in GET_ROUTES table order (HTML pages, team assets,
 *    then the JSON API)
 * 4. Everything else -> 404 (or 405 when a non-GET method hits a
 *    known GET route)
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
    rematch,
    angle,
  } = deps;

  const ctx: HandlerContext = {
    db,
    dbPath,
    getSchedulerStatus,
    logger,
    slackSigningSecret,
    slackConfig,
    rematch,
    angle,
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

        // GET routes, in table order
        for (const route of GET_ROUTES) {
          if ("path" in route) {
            if (route.path !== pathname) continue;
            response = await route.handle(ctx, url.searchParams);
          } else {
            const match = pathname.match(route.pattern);
            if (!match) continue;
            response = await route.handle(ctx, url.searchParams, match);
          }
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
        // HTML routes get a themed 500 page; JSON routes keep the JSON error.
        response =
          req.method === "GET" && isHtmlRoute(pathname)
            ? htmlResponse(ERROR_PAGE_HTML, 500)
            : jsonResponse({ error: "Internal server error" }, 500);
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
