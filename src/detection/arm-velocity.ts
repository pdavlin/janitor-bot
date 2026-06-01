/**
 * Baseball Savant arm-strength / throw-velocity fetcher.
 *
 * Fetches a fielder's season throws from the arm-strength leaderboard,
 * caches per (fielder_id, year), and resolves a single play's velocity
 * by play_id. Mirrors the pattern in savant-video.ts.
 *
 * Endpoint: GET https://baseballsavant.mlb.com/leaderboard/arm-strength/{fielderId}/{year}
 * Returns an array of ThrowRecord objects; each has a `play_id` UUID and
 * a `metric` field (throw velocity in mph).
 */

import type { Logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discriminated outcome of a single velocity-resolve attempt.
 *
 * `httpStatus` and `error` are present for log fidelity; the persisted
 * column stores only the velocity (null on non-match).
 */
export type ArmVelocityResult =
  | { status: "matched"; velocityMph: number }
  | { status: "no_match" }
  | { status: "non_200"; httpStatus: number }
  | { status: "timeout" }
  | { status: "network_error"; error: string };

/**
 * Raw record shape returned by the Savant arm-strength endpoint.
 * Only the fields we use are typed; the response has many more.
 */
interface ThrowRecord {
  year: number;
  fielder_id: number;
  pos: number;
  pos_role: number;
  metric: number; // throw velocity, mph
  play_id: string; // same UUID as extractPlayId()
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const ARM_STRENGTH_BASE_URL =
  "https://baseballsavant.mlb.com/leaderboard/arm-strength";

const FETCH_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Run-scoped cache keyed by `${fielderId}:${year}`.
 *
 * A module-level Map satisfies FR-1.5/1.6 without TTL complexity: N plays
 * by one fielder in a single pipeline run cost one HTTP request. The cache
 * is not persisted across process restarts, which is acceptable because
 * each daemon run processes a small window of games.
 */
const throwCache = new Map<string, ThrowRecord[]>();

function cacheKey(fielderId: number, year: number): string {
  return `${fielderId}:${year}`;
}

/**
 * Clears the throw cache. Useful for testing to avoid state leakage
 * between test cases.
 */
export function clearThrowCache(): void {
  throwCache.clear();
}

// ---------------------------------------------------------------------------
// Fetch + resolve
// ---------------------------------------------------------------------------

/**
 * Fetches the throws array for a (fielder, year) pair from Savant,
 * caches it, and resolves the velocity for a specific play_id.
 *
 * On cache hit, no HTTP request is made. On fetch failure, the error
 * is returned as a discriminated variant — never thrown.
 *
 * @param fielderId - MLB player id of the fielder.
 * @param year - Season year.
 * @param playId - The Savant play_id UUID to look up.
 * @param _logger - Reserved for future use.
 * @returns Discriminated ArmVelocityResult.
 */
export async function resolveThrowVelocity(
  fielderId: number,
  year: number,
  playId: string,
  _logger?: Logger,
): Promise<ArmVelocityResult> {
  const key = cacheKey(fielderId, year);

  // Cache miss → fetch and store
  if (!throwCache.has(key)) {
    const fetched = await fetchThrows(fielderId, year);
    if (fetched.status !== "success") {
      return fetched;
    }
    throwCache.set(key, fetched.records);
  }

  const records = throwCache.get(key)!;
  const match = records.find((r) => r.play_id === playId);

  if (!match) {
    return { status: "no_match" };
  }

  return { status: "matched", velocityMph: match.metric };
}

// ---------------------------------------------------------------------------
// Internal fetch
// ---------------------------------------------------------------------------

type FetchThrowsResult =
  | { status: "success"; records: ThrowRecord[] }
  | { status: "non_200"; httpStatus: number }
  | { status: "timeout" }
  | { status: "network_error"; error: string };

/**
 * Fetches the raw throws array from Savant for a (fielder, year) pair.
 * Returns the parsed array or a discriminated error.
 */
async function fetchThrows(
  fielderId: number,
  year: number,
): Promise<FetchThrowsResult> {
  try {
    const url = `${ARM_STRENGTH_BASE_URL}/${fielderId}/${year}`;
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { status: "non_200", httpStatus: response.status };
    }

    const json = await response.json();

    // Savant returns an array of objects; validate shape before trusting.
    if (!Array.isArray(json)) {
      return {
        status: "network_error",
        error: "unexpected response shape (not an array)",
      };
    }

    // Filter to only records matching the requested fielder+year
    // (the endpoint may return broader data depending on query params).
    const records: ThrowRecord[] = json
      .filter(
        (r: any) =>
          r &&
          typeof r.fielder_id === "number" &&
          typeof r.play_id === "string" &&
          typeof r.metric === "number" &&
          r.fielder_id === fielderId &&
          r.year === year,
      )
      .map((r: any) => ({
        year: r.year,
        fielder_id: r.fielder_id,
        pos: r.pos,
        pos_role: r.pos_role,
        metric: r.metric,
        play_id: r.play_id,
      }));

    return { status: "success", records };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { status: "timeout" };
    }
    return {
      status: "network_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
