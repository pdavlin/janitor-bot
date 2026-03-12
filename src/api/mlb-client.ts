/**
 * Client for the MLB Stats API.
 *
 * Uses native fetch with retry logic (exponential backoff on 5xx / network
 * errors) and a concurrency limiter (max 10 in-flight requests).
 */

import type {
  ScheduleResponse,
  LiveFeedResponse,
  ContentResponse,
  ScheduleGame,
} from "../types/mlb-api";

const MLB_BASE = "https://statsapi.mlb.com";

const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];
const MAX_CONCURRENT = 10;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class MlbApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "MlbApiError";
  }
}

// ---------------------------------------------------------------------------
// Semaphore-based concurrency limiter
// ---------------------------------------------------------------------------

let activeRequests = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitQueue.push(resolve);
  });
}

function releaseSlot(): void {
  const next = waitQueue.shift();
  if (next) {
    // Hand the slot directly to the next waiter (activeRequests stays the same).
    next();
  } else {
    activeRequests--;
  }
}

// ---------------------------------------------------------------------------
// Core fetch with retry + rate limiting
// ---------------------------------------------------------------------------

/**
 * Fetch a URL with retry on 5xx / network errors and concurrency limiting.
 *
 * @param url - Absolute URL to fetch.
 * @returns The parsed JSON body.
 * @throws {MlbApiError} On 4xx responses (not retried).
 */
async function fetchWithRetry<T>(url: string): Promise<T> {
  await acquireSlot();
  try {
    return await attemptFetch<T>(url, 0);
  } finally {
    releaseSlot();
  }
}

async function attemptFetch<T>(url: string, attempt: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    // Network failure -- retry if we have attempts left.
    if (attempt < MAX_RETRIES) {
      await sleep(BACKOFF_MS[attempt]);
      return attemptFetch<T>(url, attempt + 1);
    }
    throw new MlbApiError(
      0,
      url,
      `Network error after ${MAX_RETRIES + 1} attempts: ${String(err)}`,
    );
  }

  if (response.ok) {
    let data: T;
    try {
      data = (await response.json()) as T;
    } catch {
      throw new MlbApiError(response.status, url, "Invalid JSON response");
    }
    return data;
  }

  // 4xx -- not retryable.
  if (response.status >= 400 && response.status < 500) {
    throw new MlbApiError(
      response.status,
      url,
      `Client error ${response.status} for ${url}`,
    );
  }

  // 5xx -- retry with backoff.
  if (attempt < MAX_RETRIES) {
    await sleep(BACKOFF_MS[attempt]);
    return attemptFetch<T>(url, attempt + 1);
  }

  throw new MlbApiError(
    response.status,
    url,
    `Server error ${response.status} after ${MAX_RETRIES + 1} attempts for ${url}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/** Sport IDs to include in schedule queries. 1 = MLB, 51 = WBC. */
const DEFAULT_SPORT_IDS = [1, 51];

/**
 * Fetch the MLB schedule for a given date.
 *
 * @param date - Date string formatted as YYYY-MM-DD.
 * @param sportIds - Sport IDs to query. Defaults to MLB + WBC.
 */
export async function fetchSchedule(
  date: string,
  sportIds: number[] = DEFAULT_SPORT_IDS,
): Promise<ScheduleResponse> {
  const ids = sportIds.join(",");
  const url = `${MLB_BASE}/api/v1/schedule?sportId=${ids}&date=${encodeURIComponent(date)}`;
  return fetchWithRetry<ScheduleResponse>(url);
}

/**
 * Fetch the live feed (play-by-play + boxscore) for a game.
 *
 * @param gamePk - The unique game identifier from the schedule.
 */
export async function fetchLiveFeed(gamePk: number): Promise<LiveFeedResponse> {
  const url = `${MLB_BASE}/api/v1.1/game/${gamePk}/feed/live`;
  return fetchWithRetry<LiveFeedResponse>(url);
}

/**
 * Fetch highlight/content data for a game.
 *
 * @param gamePk - The unique game identifier from the schedule.
 */
export async function fetchGameContent(
  gamePk: number,
): Promise<ContentResponse> {
  const url = `${MLB_BASE}/api/v1/game/${gamePk}/content`;
  return fetchWithRetry<ContentResponse>(url);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return only the games that have reached a final state.
 *
 * @param schedule - A schedule response from {@link fetchSchedule}.
 */
export function getCompletedGames(schedule: ScheduleResponse): ScheduleGame[] {
  return schedule.dates.flatMap((d) =>
    d.games.filter((g) => g.status.abstractGameState === "Final"),
  );
}
