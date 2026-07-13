/**
 * Team logo asset serving for GET /assets/teams/:abbr.png.
 *
 * Maps the team abbreviations stored in the plays table (MLB Stats API
 * style, e.g. "LAD", "CWS") onto the PNG filenames bundled in
 * mlb_teams_emoji/. Unknown abbreviations 404 and the page renderer falls
 * back to a text badge.
 */

import { TEAM_ABBREV_TO_EMOJI } from "../notifications/team-emoji";

/**
 * Web-only alternate abbreviations (AZ/ARI, KC/KCR, ...) so historical
 * rows keep resolving if the Stats API abbreviation shifts. These are on
 * top of the canonical map below; the Slack formatter never sees them.
 */
const TEAM_ASSET_ALTERNATES: Record<string, string> = {
  AZ: "arizona-diamondbacks",
  KCR: "kansas-city-royals",
  SDP: "san-diego-padres",
  SFG: "san-francisco-giants",
  TBR: "tampa-bay-rays",
  WSN: "washington-nationals",
};

/**
 * DB team abbreviation -> filename (without .png) in mlb_teams_emoji/.
 * Derived from the Slack emoji map (the slugs there are the PNG filenames
 * by contract; see team-emoji.ts) plus the web-only alternates above, so
 * the two maps can't drift. Exported for the drift test in
 * src/notifications/__tests__/team-emoji.test.ts.
 */
export const TEAM_ASSET_FILES: Record<string, string> = {
  ...TEAM_ABBREV_TO_EMOJI,
  ...TEAM_ASSET_ALTERNATES,
};

/** Repo-relative asset directory, resolved from this module's location. */
const ASSET_DIR = `${import.meta.dir}/../../mlb_teams_emoji`;

/** One week; the logo set changes at most once a season. */
const CACHE_CONTROL = "public, max-age=604800, immutable";

/** Returns true when the abbreviation maps to a bundled logo file. */
export function hasTeamAsset(abbr: string): boolean {
  return TEAM_ASSET_FILES[abbr.toUpperCase()] !== undefined;
}

/**
 * Serves the logo PNG for a team abbreviation with long cache headers.
 * Returns a 404 response for unknown abbreviations or missing files.
 *
 * @param abbr        - Team abbreviation from the request path.
 * @param corsHeaders - CORS headers applied to every response so the asset
 *                      route matches the JSON/HTML routes' cross-origin
 *                      behavior on both the 200 and the 404.
 */
export async function serveTeamAsset(
  abbr: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const filename = TEAM_ASSET_FILES[abbr.toUpperCase()];
  if (!filename) {
    return new Response("Not found", { status: 404, headers: { ...corsHeaders } });
  }

  const file = Bun.file(`${ASSET_DIR}/${filename}.png`);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404, headers: { ...corsHeaders } });
  }

  return new Response(file, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "image/png",
      "Cache-Control": CACHE_CONTROL,
    },
  });
}
