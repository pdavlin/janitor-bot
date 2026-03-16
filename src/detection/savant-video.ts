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

export interface SavantVideoResult {
  videoUrl: string;
  videoTitle: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const SAVANT_BASE_URL = "https://baseballsavant.mlb.com/sporty-videos";

const FETCH_TIMEOUT_MS = 5000;

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
 * Parses the returned HTML page for a <source> tag pointing to an mp4 file
 * on sporty-clips.mlb.com. Returns null when no video exists (Spring Training,
 * WBC, or video not yet processed).
 *
 * @param playId - UUID from a pitch event's playId field.
 * @param logger - Optional structured logger for debug diagnostics.
 * @returns Video URL and title, or null if unavailable.
 */
export async function fetchSavantVideo(
  playId: string,
  logger?: Logger,
): Promise<SavantVideoResult | null> {
  try {
    const url = `${SAVANT_BASE_URL}?playId=${playId}`;
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const html = await response.text();

    if (html.includes("No Video Found")) {
      logger?.debug("no savant video available", { playId });
      return null;
    }

    const sourceMatch = html.match(/<source[^>]+src="([^"]+)"/);
    if (!sourceMatch?.[1]) {
      logger?.debug("savant video page missing source tag", { playId });
      return null;
    }

    const videoUrl = decodeHtmlEntities(sourceMatch[1]);

    logger?.debug("savant video found", { playId });

    return {
      videoUrl,
      videoTitle: "Baseball Savant Video",
    };
  } catch (err) {
    logger?.debug("savant video fetch failed", {
      playId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
