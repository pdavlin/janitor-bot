/**
 * Shared HTML building blocks for the server-rendered pages: escaping,
 * team badges, play cards, stat tiles, and tier badges.
 *
 * Every DB-sourced string that lands in HTML goes through escapeHtml here
 * or in the calling page module.
 */

import type { StoredPlay } from "../../types/play";
import type { Tier } from "../../types/play";
import { hasTeamAsset } from "../team-assets";

/**
 * Escapes a string for safe interpolation into HTML text or attribute
 * values (attributes must be double-quoted).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders a team badge. Teams with a bundled logo get the 20px PNG with the
 * abbreviation as alt text; unknown teams fall back to the text badge.
 */
export function teamBadge(abbr: string): string {
  const safe = escapeHtml(abbr);
  if (hasTeamAsset(abbr)) {
    return `<img class="team-img" src="/assets/teams/${safe}.png" alt="${safe}" width="20" height="20">`;
  }
  return `<span class="badge">${safe}</span>`;
}

/** Renders a tier badge: colored dot plus lowercase label, never color alone. */
export function tierBadge(tier: Tier): string {
  return `<span class="tier tier-${tier}"><span class="dot" aria-hidden="true"></span>${tier}</span>`;
}

/**
 * Renders a stat tile fieldset (home page headline numbers).
 *
 * @param legend  - Lowercase tile label (e.g. "plays tracked").
 * @param value   - Pre-escaped HTML for the hero figure.
 * @param context - One-line muted context (escaped here).
 * @param wide    - True for non-numeric values that need a smaller font.
 */
export function statTile(
  legend: string,
  value: string,
  context: string,
  wide = false,
): string {
  const numClass = wide ? "stat-num stat-span" : "stat-num";
  return `<fieldset role="listitem">
  <legend>${escapeHtml(legend)}</legend>
  <span class="${numClass}">${value}</span>
  <span class="stat-ctx">${escapeHtml(context)}</span>
</fieldset>`;
}

/** Formats the half inning for the matchup context line ("top 7" / "bot 3"). */
function halfInningShort(halfInning: string, inning: number): string {
  const half = halfInning === "top" ? "top" : "bot";
  return `${half} ${inning}`;
}

/** Formats the runners-on context ("1st, 2nd" or "bases empty"). */
function runnersContext(runnersOn: string): string {
  return runnersOn === "" ? "bases empty" : runnersOn;
}

/** Renders the credit chain as node/separator spans ("CF -> SS -> C"). */
function chainHtml(creditChain: string): string {
  return creditChain
    .split(" -> ")
    .map((node) => `<span class="node">${escapeHtml(node)}</span>`)
    .join('<span class="sep">-&gt;</span>');
}

/**
 * Renders one play as a fieldset card (used by the highlights gallery and
 * the home page's recent-highlights list).
 */
export function playCard(play: StoredPlay): string {
  const segments = play.creditChain.split(" -> ").length;
  const isDirect = segments === 2;
  const kindClass = isDirect ? "kind" : "kind relay";
  const kindLabel = isDirect ? "direct" : "relay";

  const ctx = [
    halfInningShort(play.halfInning, play.inning),
    `${play.outs} out`,
    runnersContext(play.runnersOn),
  ].join(" &middot; ");

  const overturnedTag = play.isOverturned
    ? `\n      <span class="overturned" title="out came via a replay-review overturn">overturned</span>`
    : "";

  const video = play.videoUrl
    ? `<a class="watch" href="${escapeHtml(play.videoUrl)}">&#9654; watch</a>`
    : `<span class="no-video">no video</span>`;

  return `<fieldset class="card">
  <legend>${escapeHtml(play.date)}</legend>
  <div class="matchup">
    ${teamBadge(play.awayTeam)}<span class="at">@</span>${teamBadge(play.homeTeam)}
    <span class="score">${play.awayScore}&ndash;${play.homeScore}</span>
    <span class="ctx">${ctx}</span>
  </div>
  <p class="headline">${escapeHtml(play.fielderName)} <span class="pos">(${escapeHtml(play.fielderPosition)})</span> <span class="arrow">&#10230;</span> ${escapeHtml(play.targetBase)} <span class="cut">&middot; cut down</span> <span class="runner">${escapeHtml(play.runnerName)}</span></p>
  <div class="chain-row">
    <div class="chain-scroll"><code class="chain">${chainHtml(play.creditChain)}</code></div>
    <span class="${kindClass}">${kindLabel}</span>
  </div>
  <div class="card-foot">
    <div class="tags">
      ${tierBadge(play.tier)}${overturnedTag}
    </div>
    ${video}
  </div>
</fieldset>`;
}

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Formats a YYYY-MM-DD date as "Mar 10". Returns the input unchanged when
 * it does not look like an ISO date.
 */
export function formatShortDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const month = MONTHS_SHORT[Number(match[2]) - 1];
  if (!month) return isoDate;
  return `${month} ${Number(match[3])}`;
}

/** Extracts the year from a YYYY-MM-DD date, or null when unparseable. */
export function yearOf(isoDate: string): string | null {
  const match = isoDate.match(/^(\d{4})-/);
  return match ? match[1] : null;
}
