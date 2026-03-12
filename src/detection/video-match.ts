/**
 * Video matching logic for MLB highlight videos.
 *
 * Given a ContentResponse from the MLB content API and a play description,
 * finds the highlight video that corresponds to a detected outfield assist.
 *
 * Matching strategy (FR-1.10 through FR-1.12):
 *   1. Primary: keyword-based match on player ID + defense taxonomy
 *   2. Fallback: description substring overlap (minimum 20 characters)
 *   3. Video URL selection prefers mp4Avc, then any mp4, then first available
 */

import type { ContentResponse, HighlightItem, Playback } from "../types/mlb-api";

/** Minimal play data needed for video matching. */
export interface PlayForMatching {
  fielderId: number;
  description: string;
}

/** A matched video result with URL and title. */
export interface VideoMatch {
  videoUrl: string;
  videoTitle: string;
}

/** Minimum character overlap required for fallback description matching. */
const MIN_DESCRIPTION_OVERLAP = 20;

/**
 * Checks whether a highlight item matches a play via keyword analysis.
 *
 * A primary match requires both:
 *   - A keyword referencing the fielder's player ID
 *   - A keyword referencing "defense" (either in value or as a taxonomy type)
 *
 * @param item - Highlight item from the content API
 * @param fielderId - MLB player ID of the fielder who made the assist
 * @returns true if both player and defense keywords are present
 */
function isKeywordMatch(item: HighlightItem, fielderId: number): boolean {
  const keywords = item.keywordsAll;
  if (!keywords?.length) return false;

  const playerIdStr = String(fielderId);

  // MLB API uses two keyword formats for players:
  //   type "player_id" -> value is the raw number string, e.g. "676962"
  //   type "player"    -> value is "playerid-{id}", e.g. "playerid-676962"
  // Using exact matches to avoid substring collisions (e.g., ID 234 matching "12345").
  const hasPlayer = keywords.some(
    (kw) =>
      (kw.type === "player_id" && kw.value === playerIdStr) ||
      (kw.type === "player" && kw.value === `playerid-${playerIdStr}`)
  );

  const hasDefense = keywords.some(
    (kw) =>
      kw.value.includes("defense") ||
      (kw.type === "taxonomy" && kw.value.includes("defense"))
  );

  return hasPlayer && hasDefense;
}

/**
 * Checks whether a highlight item matches a play via description overlap.
 *
 * Slides a window of MIN_DESCRIPTION_OVERLAP characters across the play
 * description looking for any substring that also appears in the highlight
 * description. Case-insensitive comparison.
 *
 * @param item - Highlight item from the content API
 * @param playDescription - Full text description of the play
 * @returns true if a substring of at least 20 characters overlaps
 */
function isDescriptionMatch(
  item: HighlightItem,
  playDescription: string
): boolean {
  if (!item.description || !playDescription) return false;
  if (playDescription.length < MIN_DESCRIPTION_OVERLAP) return false;

  const itemDescLower = item.description.toLowerCase();
  const playDescLower = playDescription.toLowerCase();

  for (
    let i = 0;
    i <= playDescLower.length - MIN_DESCRIPTION_OVERLAP;
    i++
  ) {
    const substring = playDescLower.slice(i, i + MIN_DESCRIPTION_OVERLAP);
    if (itemDescLower.includes(substring)) {
      return true;
    }
  }

  return false;
}

/**
 * Selects the best video URL from a highlight item's playback list.
 *
 * Preference order:
 *   1. Playback named exactly "mp4Avc"
 *   2. Any playback with "mp4" in its name
 *   3. First playback in the list
 *
 * @param playbacks - Array of playback options from a highlight item
 * @returns The best available URL, or null if no playbacks exist
 */
function selectPlaybackUrl(playbacks: Playback[] | undefined): string | null {
  if (!playbacks?.length) return null;

  const mp4Avc = playbacks.find((p) => p.name === "mp4Avc");
  if (mp4Avc) return mp4Avc.url;

  const anyMp4 = playbacks.find((p) => p.name.includes("mp4"));
  if (anyMp4) return anyMp4.url;

  return playbacks[0].url;
}

/**
 * Matches an MLB highlight video to a detected outfield assist play.
 *
 * Searches the content response highlights for a video that corresponds
 * to the given play, using keyword matching as the primary strategy and
 * description overlap as a fallback.
 *
 * @param content - Content API response for a game
 * @param play - Play data containing fielder ID and description text
 * @returns A VideoMatch with URL and title, or null if no match found
 *
 * @example
 * ```ts
 * const match = matchVideoToPlay(contentResponse, {
 *   fielderId: 676962,
 *   description: "Mookie Betts throws out runner at third base",
 * });
 * if (match) {
 *   console.log(match.videoUrl);   // "https://..."
 *   console.log(match.videoTitle); // "Betts' outfield assist"
 * }
 * ```
 */
export function matchVideoToPlay(
  content: ContentResponse,
  play: PlayForMatching
): VideoMatch | null {
  const items = content?.highlights?.highlights?.items;
  if (!items?.length) return null;

  // Primary match: keyword-based
  let matched: HighlightItem | undefined = items.find((item) =>
    isKeywordMatch(item, play.fielderId)
  );

  // Fallback match: description overlap
  if (!matched) {
    matched = items.find((item) => isDescriptionMatch(item, play.description));
  }

  if (!matched) return null;

  const videoUrl = selectPlaybackUrl(matched.playbacks);
  if (!videoUrl) return null;

  return {
    videoUrl,
    videoTitle: matched.title,
  };
}
