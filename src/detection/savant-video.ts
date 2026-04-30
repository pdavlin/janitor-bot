/**
 * Baseball Savant video fetching for outfield assist plays.
 *
 * Uses Savant's sporty-videos endpoint to retrieve mp4 URLs by playId.
 * This is the primary video source; the MLB content API serves as fallback.
 *
 * Coverage: Regular season games have Savant video. Spring Training and WBC
 * games do not.
 */

import type { PlayEvent } from "../types/mlb-api";
import type { Logger } from "../logger";

/**
 * Discriminated outcome of a single Savant fetch attempt.
 *
 * The `httpStatus` and `error` payloads are present for log fidelity; the
 * persisted `fetch_status` column stores only the discriminator.
 */
export type SavantFetchResult =
  | { status: "success"; videoUrl: string; videoTitle: string }
  | { status: "no_video_found" }
  | { status: "no_source_tag" }
  | { status: "non_200"; httpStatus: number }
  | { status: "timeout" }
  | { status: "network_error"; error: string };

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const SAVANT_BASE_URL = "https://baseballsavant.mlb.com/sporty-videos";

const FETCH_TIMEOUT_MS = 10000;

/**
 * Decodes common HTML entities found in Savant video URLs.
 *
 * Handles hex-encoded entities (&#xHH;), decimal entities (&#NNN;),
 * and named entities (&amp;).
 *
 * @param html - String potentially containing HTML entities.
 * @returns Decoded string.
 */
function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&#x([0-9A-Fa-f]+);/g, (_match, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, dec) =>
      String.fromCharCode(parseInt(dec, 10))
    )
    .replace(/&amp;/g, "&");
}

/**
 * Extracts the playId UUID from the last pitch event in a play's events array.
 *
 * Only pitch events carry a playId. The last pitch in an at-bat represents
 * the play outcome (the ball put in play, the strikeout, etc.).
 *
 * @param playEvents - Array of play events from the live feed, or undefined.
 * @returns The playId string, or null if none found.
 */
export function extractPlayId(
  playEvents: PlayEvent[] | undefined
): string | null {
  if (!playEvents?.length) return null;

  for (let i = playEvents.length - 1; i >= 0; i--) {
    const event = playEvents[i];
    if (event.isPitch && event.playId) {
      return event.playId;
    }
  }

  return null;
}

/**
 * Fetches a video URL from Baseball Savant's sporty-videos endpoint.
 *
 * Returns a discriminated result so callers can distinguish failure modes
 * (timeout vs HTTP error vs missing video). Logging of non-success branches
 * is the caller's responsibility.
 *
 * @param playId - UUID from a pitch event's playId field.
 * @param _logger - Reserved for future use; no longer logs at this layer.
 * @returns Discriminated SavantFetchResult.
 */
export async function fetchSavantVideo(
  playId: string,
  _logger?: Logger,
): Promise<SavantFetchResult> {
  try {
    const url = `${SAVANT_BASE_URL}?playId=${playId}`;
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { status: "non_200", httpStatus: response.status };
    }

    const html = await response.text();

    if (html.includes("No Video Found")) {
      return { status: "no_video_found" };
    }

    const sourceMatch = html.match(/<source[^>]+src="([^"]+)"/);
    if (!sourceMatch?.[1]) {
      return { status: "no_source_tag" };
    }

    return {
      status: "success",
      videoUrl: decodeHtmlEntities(sourceMatch[1]),
      videoTitle: "Baseball Savant Video",
    };
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
