/**
 * Standalone 1200×630 share-card SVG for a single play, served at
 * GET /play/:id/card.svg and inlined on the /play/:id permalink page.
 *
 * The card is fully self-contained: og-image renderers and social
 * scrapers never see the site's CSS, so every color is an inlined
 * LIGHT-theme hex (imported from theme.ts's exported constants — no
 * var(--...) references) and the font stack is inlined per text element.
 */

import type { StoredPlay } from "../../types/play";
import { chainSegments, isDirectThrow } from "../../detection/ranking";
import { baseDisplay, escapeHtml, mph } from "./components";
import { arcControlPoint, baseSlot } from "./charts";
import {
  ACCENT_HEX,
  CHART_SLOT_HEX,
  LIGHT_BG_HEX,
  LIGHT_INK_HEX,
  LIGHT_MUTED_HEX,
} from "./theme";

const BG = LIGHT_BG_HEX;
const INK = LIGHT_INK_HEX;
const MUTED = LIGHT_MUTED_HEX;
const ACCENT = ACCENT_HEX;

const FONT = "ui-monospace,SFMono-Regular,Menlo,monospace";

// --- credit-chain row layout -------------------------------------------------
// The chain and the velocity flex box share the y452-522 band; the mini
// diamond occupies x862+. The flex box sits at a fixed x so the chain gets
// everything to its left, and the chain's font shrinks stepwise until the
// text fits — sized so the longest real chain in the DB (5 segments) plus
// one segment of headroom still clears the box.

/** Left edge of the credit chain text. */
const CHAIN_X = 60;

/** Left edge of the velocity flex box. */
const FLEX_X = 610;

/** Minimum clearance between the chain text and the flex box. */
const FLEX_GAP = 24;

/** Right limit for the chain when no flex box renders (diamond at ~862). */
const CHAIN_MAX_X_NO_FLEX = 840;

/** Letter-spacing applied to the chain text, part of each glyph's advance. */
const CHAIN_LETTER_SPACING = 3;

/**
 * Picks the largest step size at which the chain text fits the available
 * width, estimating the monospace advance as 0.6em plus letter-spacing
 * per glyph. The 22px floor fits a 6-segment chain (32 chars) in the
 * flex-constrained width.
 */
function chainFontSize(plainChain: string, maxWidth: number): number {
  for (const size of [40, 34, 28, 22] as const) {
    if (plainChain.length * (size * 0.6 + CHAIN_LETTER_SPACING) <= maxWidth) {
      return size;
    }
  }
  return 22;
}

/**
 * The mini diamond with the throw arc, in a local 180×180-ish coordinate
 * space (home at 90,150; 2B at 90,30). Origin dot placement depends on
 * the fielder's position; the arc bows via the shared arc-geometry helper.
 */
function miniDiamond(play: StoredPlay): string {
  const TARGET: Record<string, { x: number; y: number }> = {
    Home: { x: 90, y: 150 },
    "1B": { x: 150, y: 90 },
    "2B": { x: 90, y: 30 },
    "3B": { x: 30, y: 90 },
  };
  const ORIGIN: Record<string, { x: number; y: number }> = {
    LF: { x: -8, y: 26 },
    CF: { x: 90, y: -14 },
    RF: { x: 188, y: 26 },
  };
  const origin = ORIGIN[play.fielderPosition] ?? ORIGIN.RF!;
  const target = TARGET[play.targetBase] ?? TARGET.Home!;
  const arcColor = CHART_SLOT_HEX[baseSlot(play.targetBase)];
  const { cx, cy } = arcControlPoint(origin, target, { x: 90, y: 90 }, 0.4, 20, 60);

  const baseRect = (p: { x: number; y: number }): string =>
    `<rect x="${p.x - 6}" y="${p.y - 6}" width="12" height="12" rx="1" transform="rotate(45 ${p.x} ${p.y})" fill="${BG}" stroke="${MUTED}"/>`;

  return `<g transform="translate(870 355)">
    <polygon points="90,150 150,90 90,30 30,90" fill="none" stroke="${MUTED}" stroke-opacity="0.5" stroke-width="1.5"/>
    ${baseRect(TARGET.Home!)}
    ${baseRect(TARGET["1B"]!)}
    ${baseRect(TARGET["2B"]!)}
    ${baseRect(TARGET["3B"]!)}
    <circle cx="${origin.x}" cy="${origin.y}" r="6" fill="${INK}"/>
    <text x="${origin.x}" y="${origin.y - 10}" text-anchor="middle" font-family="${FONT}" font-size="15" fill="${MUTED}">${escapeHtml(play.fielderPosition)}</text>
    <path d="M${origin.x} ${origin.y} Q ${Math.round(cx)} ${Math.round(cy)} ${target.x} ${target.y}" fill="none" stroke="${arcColor}" stroke-width="5" stroke-linecap="round"/>
    <text x="90" y="172" text-anchor="middle" font-family="${FONT}" font-size="15" fill="${MUTED}">${escapeHtml(baseDisplay(play.targetBase))}</text>
  </g>`;
}

/** Velocity flex box, or an empty string when the play has no reading. */
function velocityFlex(play: StoredPlay): string {
  if (play.throwVelocity == null || play.throwVelocity <= 0) return "";
  return `<g transform="translate(${FLEX_X} 452)">
    <rect x="0" y="0" width="230" height="70" fill="none" stroke="${ACCENT}" stroke-width="1.5"/>
    <text x="20" y="47" font-family="${FONT}" font-size="46" font-weight="700" fill="${ACCENT}">${mph(play.throwVelocity)}</text>
    <text x="185" y="47" font-family="${FONT}" font-size="22" fill="${MUTED}">mph</text>
  </g>`;
}

/**
 * Renders the full share-card SVG document for a play.
 *
 * Layout per the approved fielder/permalink mockup: accent top bar, date +
 * tier header row, matchup line, two-line headline, mini diamond arc,
 * credit chain, optional velocity flex, wordmark footer with the
 * permalink path.
 */
export function renderShareCardSvg(play: StoredPlay): string {
  const headlineSize = play.fielderName.length > 18 ? 44 : 54;
  const segments = chainSegments(play.creditChain);
  const plainChain = segments.join(" -> ");
  const flexVelocity =
    play.throwVelocity != null && play.throwVelocity > 0 ? play.throwVelocity : null;
  const chainMaxWidth =
    (flexVelocity != null ? FLEX_X - FLEX_GAP : CHAIN_MAX_X_NO_FLEX) - CHAIN_X;
  const chainSize = chainFontSize(plainChain, chainMaxWidth);
  const chain = segments
    .map((node) => escapeHtml(node))
    .join(`<tspan fill="${MUTED}"> -&gt; </tspan>`);
  const kind = isDirectThrow(play.creditChain) ? "direct" : "relay";
  const half = play.halfInning === "top" ? "top" : "bot";
  const velocityAria =
    flexVelocity != null ? `, a ${mph(flexVelocity)} mph throw` : "";
  const aria = `Share card: ${play.fielderName}, ${play.fielderPosition}, cut down ${play.runnerName} at ${baseDisplay(play.targetBase)} on ${play.date}${velocityAria}, ${play.awayTeam} at ${play.homeTeam}.`;

  return `<svg viewBox="0 0 1200 630" width="1200" height="630" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(aria)}">
  <rect x="0" y="0" width="1200" height="630" fill="${BG}"/>
  <rect x="20" y="20" width="1160" height="590" fill="none" stroke="${MUTED}" stroke-width="1"/>
  <rect x="20" y="20" width="1160" height="8" fill="${ACCENT}"/>

  <text x="60" y="92" font-family="${FONT}" font-size="26" letter-spacing="1" fill="${MUTED}">${escapeHtml(play.date)}</text>
  <g>
    <circle cx="968" cy="84" r="9" fill="${ACCENT}" stroke="${INK}" stroke-opacity="0.25"/>
    <text x="1140" y="92" text-anchor="end" font-family="${FONT}" font-size="26" letter-spacing="2" fill="${INK}">${play.tier} tier</text>
  </g>
  <line x1="60" y1="118" x2="1140" y2="118" stroke="${MUTED}" stroke-opacity="0.35" stroke-width="1"/>

  <text x="60" y="168" font-family="${FONT}" font-size="30" fill="${INK}"><tspan font-weight="700">${escapeHtml(play.awayTeam)}</tspan><tspan fill="${MUTED}"> @ </tspan><tspan font-weight="700">${escapeHtml(play.homeTeam)}</tspan><tspan fill="${MUTED}">&#160;&#160;&#160;${half} ${play.inning}&#160;&#160;&#183;&#160;&#160;${play.awayScore}&#8211;${play.homeScore} at the time&#160;&#160;&#183;&#160;&#160;${play.outs} out</tspan></text>

  <text x="60" y="268" font-family="${FONT}" font-size="${headlineSize}" font-weight="700" fill="${INK}">${escapeHtml(play.fielderName)} <tspan fill="${MUTED}" font-weight="400" font-size="40">(${escapeHtml(play.fielderPosition)})</tspan></text>
  <text x="60" y="334" font-family="${FONT}" font-size="40" fill="${INK}"><tspan fill="${ACCENT}">&#10230;</tspan> ${escapeHtml(play.targetBase)} <tspan fill="${MUTED}">&#183; cut down</tspan> ${escapeHtml(play.runnerName)}</text>

  ${miniDiamond(play)}

  <text x="${CHAIN_X}" y="452" font-family="${FONT}" font-size="22" letter-spacing="2" fill="${MUTED}">credit &#183; ${kind}</text>
  <text x="${CHAIN_X}" y="492" font-family="${FONT}" font-size="${chainSize}" letter-spacing="${CHAIN_LETTER_SPACING}" fill="${INK}">${chain}</text>

  ${velocityFlex(play)}

  <line x1="60" y1="556" x2="1140" y2="556" stroke="${MUTED}" stroke-opacity="0.35" stroke-width="1"/>
  <text x="60" y="590" font-family="${FONT}" font-size="24" letter-spacing="1" fill="${INK}" font-weight="700">janitor-bot<tspan fill="${MUTED}" font-weight="400">  &#183; outfield assists, tracked</tspan></text>
  <text x="1140" y="590" text-anchor="end" font-family="${FONT}" font-size="20" fill="${MUTED}">/play/${play.id}</text>
</svg>`;
}
