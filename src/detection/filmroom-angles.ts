/**
 * Film Room alternate-angle fetcher for outfield assist plays.
 *
 * Given a (gamePk, playId), probes the Film Room CDN for the candidate
 * feeds and returns every available one's URL and downloaded bytes so the
 * caller can upload them to Slack.
 *
 * The CDN URL pattern is:
 *   https://fastball-clips.mlb.com/{gamePk}/{feedType}/{playId}.mp4
 *
 * with header `Referer: https://www.mlb.com/video`. Without the Referer,
 * the CDN 302-redirects to a Film Room search page instead of serving the
 * video.
 *
 * Feeds: the home/away broadcasts follow the ball into the outfield (the
 * throw, the tag); `highhome` is the elevated camera behind the plate that
 * looks out over the field and may also frame the throw. We deliberately
 * exclude `cf` — it looks IN at the pitcher from center field and only
 * shows the pitch and contact, never the outfielder's throw.
 */

import type { Logger } from "../logger";

/** Candidate feed types, in preference order. */
export type FeedType = "home" | "away" | "highhome";

/** A successfully fetched feed clip. */
export interface FoundAngle {
  feedType: FeedType;
  url: string;
  bytes: ArrayBuffer;
}

/**
 * Feeds to fetch, in order. home/away are the broadcasts that follow the
 * ball; highhome is the behind-the-plate elevated camera (added to evaluate
 * whether it frames the outfield throw).
 */
const ANGLE_PREFERENCE: readonly FeedType[] = ["home", "away", "highhome"] as const;

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
 * Probes the Film Room CDN for ALL candidate feeds (home, away, highhome)
 * and returns every one that is available, each with its downloaded bytes.
 *
 * Each feed is a distinct view of the play, so the caller posts all that
 * exist. A 400/404/error on one feed is skipped; the others still return.
 * Empty array = no angle available for this play.
 *
 * @param gamePk - MLB game identifier.
 * @param playId - Savant play UUID.
 * @param logger - Optional logger for diagnostics.
 * @returns Array of found angles (possibly empty); each carries its bytes.
 */
export async function resolveAlternateAngles(
  gamePk: number,
  playId: string,
  logger?: Logger,
): Promise<FoundAngle[]> {
  const found: FoundAngle[] = [];

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
        found.push({ feedType, url, bytes });
        continue;
      }

      // 400/404 → this feed isn't available for the play; others may be.
      if (response.status === 400 || response.status === 404) {
        logger?.debug("filmroom angle not available", {
          gamePk,
          playId,
          feedType,
          httpStatus: response.status,
        });
        continue;
      }

      logger?.warn("filmroom angle unexpected status", {
        gamePk,
        playId,
        feedType,
        httpStatus: response.status,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        logger?.warn("filmroom angle timeout", { gamePk, playId, feedType });
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

  if (found.length === 0) {
    logger?.debug("filmroom no alternate angle available", { gamePk, playId });
  }
  return found;
}
