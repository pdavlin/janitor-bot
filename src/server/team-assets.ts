/**
 * Team logo asset serving for GET /assets/teams/:abbr.png.
 *
 * Maps the team abbreviations stored in the plays table (MLB Stats API
 * style, e.g. "LAD", "CWS") onto the PNG filenames bundled in
 * mlb_teams_emoji/. Unknown abbreviations 404 and the page renderer falls
 * back to a text badge.
 */

/**
 * DB team abbreviation -> filename (without .png) in mlb_teams_emoji/.
 * Includes common alternates (AZ/ARI, KC/KCR, ...) so historical rows keep
 * resolving if the Stats API abbreviation shifts.
 */
const TEAM_ASSET_FILES: Record<string, string> = {
  ARI: "arizona-diamondbacks",
  AZ: "arizona-diamondbacks",
  ATH: "athletics",
  OAK: "athletics",
  ATL: "atlanta-braves",
  BAL: "baltimore-orioles",
  BOS: "boston-red-sox",
  CHC: "chicago-cubs",
  CWS: "chicago-white-sox",
  CHW: "chicago-white-sox",
  CIN: "cincinnati-reds",
  CLE: "cleveland-guardians",
  COL: "colorado-rockies",
  DET: "detroit-tigers",
  HOU: "houston-astros",
  KC: "kansas-city-royals",
  KCR: "kansas-city-royals",
  LAA: "los-angeles-angels",
  LAD: "los-angeles-dodgers",
  MIA: "miami-marlins",
  MIL: "milwaukee-brewers",
  MIN: "minnesota-twins",
  NYM: "new-york-mets",
  NYY: "new-york-yankees",
  PHI: "philadelphia-phillies",
  PIT: "pittsburgh-pirates",
  SD: "san-diego-padres",
  SDP: "san-diego-padres",
  SEA: "seattle-mariners",
  SF: "san-francisco-giants",
  SFG: "san-francisco-giants",
  STL: "st-louis-cardinals",
  TB: "tampa-bay-rays",
  TBR: "tampa-bay-rays",
  TEX: "texas-rangers",
  TOR: "toronto-blue-jays",
  WSH: "washington-nationals",
  WSN: "washington-nationals",
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
 */
export async function serveTeamAsset(abbr: string): Promise<Response> {
  const filename = TEAM_ASSET_FILES[abbr.toUpperCase()];
  if (!filename) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(`${ASSET_DIR}/${filename}.png`);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(file, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": CACHE_CONTROL,
    },
  });
}
