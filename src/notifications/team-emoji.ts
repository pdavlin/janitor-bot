/**
 * MLB team abbreviation -> Slack emoji slug.
 *
 * Slugs match the names of the custom emoji uploaded to the Slack workspace.
 * The repo's `mlb_teams_emoji/` folder holds reference copies of the uploaded
 * PNG files; filenames there should track Slack names so the directory-walking
 * test in `__tests__/team-emoji.test.ts` catches drift.
 */
export const TEAM_ABBREV_TO_EMOJI: Record<string, string> = {
  ARI: "arizona-diamondbacks",
  ATH: "athletics",
  ATL: "atlanta-braves",
  BAL: "baltimore-orioles",
  BOS: "boston-red-sox",
  CHC: "chicago-cubs",
  CHW: "chicago-white-sox",
  CIN: "cincinnati-reds",
  CLE: "cleveland-guardians",
  COL: "colorado-rockies",
  CWS: "chicago-white-sox",
  DET: "detroit-tigers",
  HOU: "houston-astros",
  KC: "kansas-city-royals",
  LAA: "los-angeles-angels",
  LAD: "los-angeles-dodgers",
  MIA: "miami-marlins",
  MIL: "milwaukee-brewers",
  MIN: "minnesota-twins",
  NYM: "new-york-mets",
  NYY: "new-york-yankees",
  OAK: "athletics",
  PHI: "philadelphia-phillies",
  PIT: "pittsburgh-pirates",
  SD: "san-diego-padres",
  SEA: "seattle-mariners",
  SF: "san-francisco-giants",
  STL: "st-louis-cardinals",
  TB: "tampa-bay-rays",
  TEX: "texas-rangers",
  TOR: "toronto-blue-jays",
  WSH: "washington-nationals",
};

/**
 * Returns the Slack emoji slug for an MLB team abbreviation, or null when the
 * abbreviation has no mapping. Callers degrade to a no-emoji rendering rather
 * than emitting a broken `:undefined:` shortcode.
 */
export function teamEmoji(abbrev: string): string | null {
  return TEAM_ABBREV_TO_EMOJI[abbrev] ?? null;
}
