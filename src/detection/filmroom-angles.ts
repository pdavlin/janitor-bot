/**
 * Film Room alternate-angle fetcher for outfield assist plays.
 *
 * Given a (gamePk, playId), probes the Film Room CDN for the broadcast
 * feeds (home, then away) and returns the first available one's URL and
 * downloaded bytes so the caller can upload the clip to Slack.
 *
 * The CDN URL pattern is:
 *   https://fastball-clips.mlb.com/{gamePk}/{feedType}/{playId}.mp4
 *
 * with header `Referer: https://www.mlb.com/video`. Without the Referer,
 * the CDN 302-redirects to a Film Room search page instead of serving the
 * video.
 *
 * We use the broadcast feeds (home/away), NOT the fixed Statcast cameras:
 * cf/highhome are anchored on the pitcher/plate and only show the pitch and
 * contact, never the outfielder's throw. The broadcast feed follows the
 * ball into the outfield, the throw, and the tag.
 */

import type { Logger } from "../logger";

/** Broadcast feed types, in preference order. */
export type FeedType = "home" | "away";

/**
 * Discriminated outcome of an alternate-angle fetch attempt.
 *
 * `no_alternate` (a definite "no angle for this play") is distinct from
 * `error` (transient) so the handler can log them differently; both result
 * in no post to the thread.
 */
export type AngleResult =
  | { status: "found"; feedType: FeedType; url: string; bytes: ArrayBuffer }
  | { status: "no_alternate" }
  | { status: "error"; error: string };

/** Broadcast feeds in preference order; they follow the ball and show the throw. */
const ANGLE_PREFERENCE: readonly FeedType[] = ["home", "away"] as const;

const REFERER = "https://www.mlb.com/video";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const FETCH_TIMEOUT_MS = 15000;

/**
 * Builds the Film Room CDN URL for a specific feed type and play.
 *
 * @param gamePk - MLB game identifier.
 * @param feedType - Broadcast feed: "home" or "away".
 * @param playId - Savant play UUID (same as `extractPlayId` produces).
 * @returns The CDN URL string.
 */
export function buildAngleUrl(
  gamePk: number,
  feedType: FeedType,
  playId: string,
): string {
  return `https://fastball-clips.mlb.com/${gamePk}/${feedType}/${playId}.mp4`;
}

/**
 * Probes the Film Room CDN for the broadcast feeds and returns the first
 * available one with its downloaded bytes.
 *
 * Tries `home` first, then `away`. On a 200 response, downloads the full
 * mp4 (6-9 MB typically). On 400/404, tries the next feed type.
 *
 * @param gamePk - MLB game identifier.
 * @param playId - Savant play UUID.
 * @param logger - Optional logger for diagnostics.
 * @returns Discriminated result: found (with bytes), no_alternate, or error.
 */
export async function resolveAlternateAngle(
  gamePk: number,
  playId: string,
  logger?: Logger,
): Promise<AngleResult> {
  for (const feedType of ANGLE_PREFERENCE) {
    const url = buildAngleUrl(gamePk, feedType, playId);

    try {
      const response = await fetch(url, {
        headers: {
          Referer: REFERER,
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.ok) {
        const bytes = await response.arrayBuffer();
        logger?.debug("filmroom angle found", {
          gamePk,
          playId,
          feedType,
          url,
          sizeBytes: bytes.byteLength,
        });
        return { status: "found", feedType, url, bytes };
      }

      // 400/404 → try next feed type. Other errors are also non-fatal
      // for this feed type but logged for diagnostics.
      if (response.status === 400 || response.status === 404) {
        logger?.debug("filmroom angle not available", {
          gamePk,
          playId,
          feedType,
          httpStatus: response.status,
        });
        continue;
      }

      // Unexpected non-200 — log and try next.
      logger?.warn("filmroom angle unexpected status", {
        gamePk,
        playId,
        feedType,
        httpStatus: response.status,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        logger?.warn("filmroom angle timeout", { gamePk, playId, feedType });
        // Timeout on one feed type is likely to timeout on the other too,
        // but spec says try each.
        continue;
      }
      logger?.warn("filmroom angle fetch error", {
        gamePk,
        playId,
        feedType,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }

  logger?.debug("filmroom no alternate angle available", { gamePk, playId });
  return { status: "no_alternate" };
}
