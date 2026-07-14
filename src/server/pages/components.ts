/**
 * Shared HTML building blocks for the server-rendered pages: escaping,
 * team badges, play cards, stat tiles, and tier badges.
 *
 * Every DB-sourced string that lands in HTML goes through escapeHtml here
 * or in the calling page module.
 */

import type { StoredPlay } from "../../types/play";
import type { Tier } from "../../types/play";
import { chainSegments, isDirectThrow } from "../../detection/ranking";
import { hasTeamAsset } from "../team-assets";

/**
 * Escapes a string for safe interpolation into HTML text or attribute
 * values (attributes must be double-quoted).
 *
 * Delegates to Bun's native escaper (repo policy: prefer Bun built-ins).
 * Note the single-quote entity is `&#x27;` (Bun's form), not `&#39;`.
 */
export function escapeHtml(value: string): string {
  return Bun.escapeHTML(value);
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

/** The play fields the shared headline fragment renders from. */
export interface PlayHeadlineFields {
  fielderName: string;
  fielderPosition: string;
  targetBase: string;
  runnerName: string;
}

/**
 * Shared headline fragment: "Name (POS) ⟶ Base · cut down Runner".
 * Rendered inside an element carrying class="headline" (the shared CSS
 * scope for the pos/arrow/cut/runner spans) by the play card and the /ops
 * most-loved and disputed lists. All fields are escaped here.
 */
export function playHeadline(play: PlayHeadlineFields): string {
  return `${escapeHtml(play.fielderName)} <span class="pos">(${escapeHtml(play.fielderPosition)})</span> <span class="arrow">&#10230;</span> ${escapeHtml(play.targetBase)} <span class="cut">&middot; cut down</span> <span class="runner">${escapeHtml(play.runnerName)}</span>`;
}

/**
 * Percentage share of total, e.g. "64%" (decimals = 0) or "64.4%"
 * (decimals = 1). A zero total renders as a zero share.
 */
export function share(count: number, total: number, decimals = 0): string {
  if (total === 0) return `${(0).toFixed(decimals)}%`;
  return `${((count / total) * 100).toFixed(decimals)}%`;
}

/** Muted empty-state paragraph shared by the section renderers. */
export function emptyNote(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

/**
 * Standard page section: a fieldset with a legend, falling back to a
 * muted empty note when the body is null. Shared by the /season sections
 * and the fielder-profile panels. (The /ops page keeps its own local
 * section helper: its sections are section-head divs grouped inside
 * larger fieldsets, a structurally different shape.)
 *
 * @param legend    - Trusted lowercase section label.
 * @param body      - Pre-escaped section markup, or null for the empty state.
 * @param emptyText - Empty-state copy (escaped by emptyNote).
 */
export function section(
  legend: string,
  body: string | null,
  emptyText = "no data yet.",
): string {
  return `<fieldset>
    <legend>${legend}</legend>
    ${body ?? emptyNote(emptyText)}
  </fieldset>`;
}

/**
 * Display form of a target base: "Home" reads as lowercase "home" in
 * running text and labels; the numbered bases stay as-is. Shared by the
 * throw-map keys, the permalink og copy, and the share card.
 */
export function baseDisplay(targetBase: string): string {
  return targetBase === "Home" ? "home" : targetBase;
}

/**
 * Velocity display: one decimal, Statcast convention (e.g. "101.2").
 * Shared by the play card chip, the season velocity sections, the fielder
 * page, and the share card.
 */
export function mph(velocity: number): string {
  return velocity.toFixed(1);
}

/**
 * The measured-velocity chip rendered next to the tier badge, or an empty
 * string when the play has no measured velocity (absent state renders
 * nothing extra — never a fake zero).
 */
export function mphChip(throwVelocity: number | null): string {
  if (throwVelocity == null || throwVelocity <= 0) return "";
  return `<span class="mph"><span class="n">${mph(throwVelocity)}</span><span class="u">mph</span></span>`;
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
  return chainSegments(creditChain)
    .map((node) => `<span class="node">${escapeHtml(node)}</span>`)
    .join('<span class="sep">-&gt;</span>');
}

/**
 * Returns true when the value parses as an absolute http(s) URL. Guards the
 * watch link against non-web schemes (javascript:, data:, ...) that a bad
 * DB row could otherwise inject into an href.
 */
function isSafeHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Renders one play as a fieldset card (used by the highlights gallery, the
 * home page's recent-highlights list, the fielder profile, and the play
 * permalink). The date legend links to the play's permalink page.
 */
export function playCard(play: StoredPlay): string {
  const isDirect = isDirectThrow(play.creditChain);
  const kindClass = isDirect ? "kind" : "kind relay";
  const kindLabel = isDirect ? "direct" : "relay";

  // Score is the game state when the play happened, not the final — keep it
  // unbolded inside the situation cluster with an explicit marker so it can't
  // read as a final score.
  const ctx = [
    halfInningShort(play.halfInning, play.inning),
    `${play.awayScore}&ndash;${play.homeScore} at the time`,
    `${play.outs} out`,
    escapeHtml(runnersContext(play.runnersOn)),
  ].join(" &middot; ");

  const overturnedTag = play.isOverturned
    ? `\n      <span class="overturned" title="out came via a replay-review overturn">overturned</span>`
    : "";

  const chip = mphChip(play.throwVelocity);
  const chipTag = chip === "" ? "" : `\n      ${chip}`;

  const video =
    play.videoUrl && isSafeHttpUrl(play.videoUrl)
      ? `<a class="watch" href="${escapeHtml(play.videoUrl)}">&#9654; watch</a>`
      : `<span class="no-video">no video</span>`;

  return `<fieldset class="card">
  <legend><a class="plink" href="/play/${play.id}">${escapeHtml(play.date)}</a></legend>
  <div class="matchup">
    ${teamBadge(play.awayTeam)}<span class="at">@</span>${teamBadge(play.homeTeam)}
    <span class="ctx">${ctx}</span>
  </div>
  <p class="headline">${playHeadline(play)}</p>
  <div class="chain-row">
    <div class="chain-scroll"><code class="chain">${chainHtml(play.creditChain)}</code></div>
    <span class="${kindClass}">${kindLabel}</span>
  </div>
  <div class="card-foot">
    <div class="tags">
      ${tierBadge(play.tier)}${overturnedTag}${chipTag}
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
 * Formats a YYYY-MM-DD date as "Mar 10". The ISO-formatted result is safe
 * ASCII, but the non-ISO fallback returns escaped input so callers that
 * treat this output as pre-escaped HTML (statTile value, season subhead)
 * cannot leak a raw DB string.
 */
export function formatShortDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return escapeHtml(isoDate);
  const month = MONTHS_SHORT[Number(match[2]) - 1];
  if (!month) return escapeHtml(isoDate);
  return `${month} ${Number(match[3])}`;
}

/** Extracts the year from a YYYY-MM-DD date, or null when unparseable. */
export function yearOf(isoDate: string): string | null {
  const match = isoDate.match(/^(\d{4})-/);
  return match ? match[1] : null;
}

/**
 * Formats a coverage date span as pre-escaped HTML, e.g.
 * "Mar 10 &ndash; Jun 23, 2026". Shared by the /season subhead and the
 * /ops coverage note.
 */
export function dateSpan(oldest: string, newest: string): string {
  const year = yearOf(newest);
  return `${formatShortDate(oldest)} &ndash; ${formatShortDate(newest)}${year ? `, ${year}` : ""}`;
}
