/**
 * Server-rendered inline SVG chart helpers for the /season page.
 *
 * Ported from the approved season mockup: thin marks with a 4px rounded
 * data-end and a square baseline, 2px surface gaps between stacked
 * segments, recessive 1px gridlines, selective direct labels, and a
 * details-collapsed data-table twin per chart.
 *
 * Charts render fully without JavaScript; the small TOOLTIP_SCRIPT is a
 * progressive enhancement that wires hover/focus tooltips onto every
 * element carrying class="mark" with data-v/data-l attributes.
 */

import { escapeHtml, mph } from "./components";
import { VELOCITY_THRESHOLD_MPH } from "../../detection/ranking";
import type { MeasuredThrow, ThrowLane } from "../../storage/db";

/** One labelled numeric row (weekly bars and horizontal bar charts). */
export interface ChartRow {
  label: string;
  value: number;
  /** CSS color expression, e.g. "var(--chart-1)". Trusted, not DB-sourced. */
  color: string;
}

/** One direct/relay split row for the 100% stacked chart. */
export interface MixRow {
  label: string;
  direct: number;
  relay: number;
}

/** Formats an SVG coordinate compactly (2 decimal places max). */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * Horizontal bar path: square left edge (baseline), 4px-rounded right edge
 * (the data end). r=0 yields a plain rectangle (stacked interior segments).
 */
function hbarPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w, h / 2));
  return `M${fmt(x)},${fmt(y)}` +
    `H${fmt(x + w - rr)}A${fmt(rr)},${fmt(rr)} 0 0 1 ${fmt(x + w)},${fmt(y + rr)}` +
    `V${fmt(y + h - rr)}A${fmt(rr)},${fmt(rr)} 0 0 1 ${fmt(x + w - rr)},${fmt(y + h)}` +
    `H${fmt(x)}Z`;
}

/** Vertical column path: square bottom (baseline), rounded top (data end). */
function colPath(x: number, yTop: number, w: number, yBot: number, r: number): string {
  const h = yBot - yTop;
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${fmt(x)},${fmt(yBot)}` +
    `V${fmt(yTop + rr)}A${fmt(rr)},${fmt(rr)} 0 0 1 ${fmt(x + rr)},${fmt(yTop)}` +
    `H${fmt(x + w - rr)}A${fmt(rr)},${fmt(rr)} 0 0 1 ${fmt(x + w)},${fmt(yTop + rr)}` +
    `V${fmt(yBot)}Z`;
}

/**
 * Picks a rounded axis maximum and tick values covering maxValue with at
 * most five gridlines (e.g. 33 -> max 40, ticks 0/10/20/30/40).
 */
function niceScale(maxValue: number): { max: number; ticks: number[] } {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  for (const step of steps) {
    if (maxValue <= step * 4) {
      const max = Math.max(step, Math.ceil(maxValue / step) * step);
      const ticks: number[] = [];
      for (let t = 0; t <= max; t += step) ticks.push(t);
      return { max, ticks };
    }
  }
  return { max: maxValue, ticks: [0, maxValue] };
}

/** Attributes shared by every tooltip-capable mark. */
function markAttrs(value: string, label: string): string {
  const v = escapeHtml(value);
  const l = escapeHtml(label);
  return `class="mark" tabindex="0" role="img" aria-label="${v} ${l}" data-v="${v}" data-l="${l}"`;
}

/**
 * Chart 1: plays per week as vertical columns, single accent series,
 * selective direct label on the peak week, x labels every other bar.
 */
export function renderWeeklyChart(weeks: ChartRow[], ariaLabel: string): string {
  const W = 700;
  const H = 260;
  const PL = 30;
  const PR = 12;
  const PT = 16;
  const PB = 34;
  const bot = H - PB;
  const plotH = bot - PT;
  const innerW = W - PL - PR;
  const { max: dmax, ticks } = niceScale(Math.max(...weeks.map((w) => w.value)));
  const band = innerW / weeks.length;
  const barW = Math.min(20, band * 0.5);
  const y = (v: number): number => bot - (v / dmax) * plotH;

  const parts: string[] = [];
  for (const t of ticks) {
    parts.push(
      `<line x1="${PL}" y1="${fmt(y(t))}" x2="${W - PR}" y2="${fmt(y(t))}" stroke="var(--grid)" stroke-width="1"/>`,
      `<text x="${PL - 6}" y="${fmt(y(t) + 3)}" text-anchor="end" font-size="10" font-variant-numeric="tabular-nums">${t}</text>`,
    );
  }

  let peak = 0;
  weeks.forEach((w, i) => {
    const current = weeks[peak];
    if (current && w.value > current.value) peak = i;
  });

  weeks.forEach((w, i) => {
    const x = PL + i * band + (band - barW) / 2;
    parts.push(
      `<path d="${colPath(x, y(w.value), barW, bot, 4)}" fill="${w.color}" ${markAttrs(String(w.value), `plays · week of ${w.label}`)}/>`,
    );
    if (i % 2 === 0) {
      parts.push(
        `<text x="${fmt(x + barW / 2)}" y="${bot + 15}" text-anchor="middle" font-size="9.5">${escapeHtml(w.label)}</text>`,
      );
    }
    if (i === peak) {
      parts.push(
        `<text x="${fmt(x + barW / 2)}" y="${fmt(y(w.value) - 6)}" text-anchor="middle" font-size="11" class="t-ink" font-variant-numeric="tabular-nums">${w.value}</text>`,
      );
    }
  });

  parts.push(
    `<line x1="${PL}" y1="${bot}" x2="${W - PR}" y2="${bot}" stroke="var(--grid)" stroke-width="1"/>`,
  );

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join("")}</svg>`;
}

/** X where hbar row labels start (after the swatch dot at cx=10). */
const HBAR_LABEL_X = 20;

/** Approximate advance width of one 11px glyph in the monospace stack. */
const HBAR_LABEL_CHAR_W = 6.6;

/** Gap between the end of the longest row label and the bar baseline. */
const HBAR_LABEL_GAP = 8;

/**
 * Charts 2 and 3: horizontal bars with a left label + swatch dot per row
 * and a direct count label at each bar tip.
 *
 * The left gutter is derived from the longest row label (11px monospace
 * advance estimate) so longer label sets ("unfetched" on /ops) don't run
 * under the bars, clamped to a third of the width so a pathological label
 * cannot consume the plot area.
 */
export function renderHBarChart(
  rows: ChartRow[],
  unitLabel: string,
  ariaLabel: string,
): string {
  const W = 700;
  const maxLabelChars = Math.max(...rows.map((r) => r.label.length));
  const PL = Math.min(
    Math.ceil(HBAR_LABEL_X + maxLabelChars * HBAR_LABEL_CHAR_W) + HBAR_LABEL_GAP,
    Math.floor(W / 3),
  );
  const PR = 34;
  const PT = 10;
  const PB = 26;
  const H = PT + PB + rows.length * 45;
  const innerW = W - PL - PR;
  const plotH = H - PT - PB;
  const band = plotH / rows.length;
  const barH = Math.min(20, band * 0.5);
  const { max: dmax, ticks } = niceScale(Math.max(...rows.map((r) => r.value)));
  const x = (v: number): number => PL + (v / dmax) * innerW;

  const parts: string[] = [];
  for (const t of ticks) {
    parts.push(
      `<line x1="${fmt(x(t))}" y1="${PT}" x2="${fmt(x(t))}" y2="${H - PB}" stroke="var(--grid)" stroke-width="1"/>`,
      `<text x="${fmt(x(t))}" y="${H - PB + 15}" text-anchor="middle" font-size="9.5" font-variant-numeric="tabular-nums">${t}</text>`,
    );
  }

  rows.forEach((row, i) => {
    const cy = PT + i * band + band / 2;
    const yTop = cy - barH / 2;
    parts.push(
      `<circle cx="10" cy="${fmt(cy)}" r="4" fill="${row.color}"/>`,
      `<text x="${HBAR_LABEL_X}" y="${fmt(cy + 3.5)}" text-anchor="start" font-size="11" class="t-ink">${escapeHtml(row.label)}</text>`,
      `<path d="${hbarPath(PL, yTop, Math.max(0.5, x(row.value) - PL), barH, 4)}" fill="${row.color}" ${markAttrs(String(row.value), `${row.label} · ${unitLabel}`)}/>`,
      `<text x="${fmt(x(row.value) + 6)}" y="${fmt(cy + 3.5)}" text-anchor="start" font-size="11" class="t-ink" font-variant-numeric="tabular-nums">${row.value}</text>`,
    );
  });

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join("")}</svg>`;
}

/**
 * Chart 4: direct vs relay as 100%-stacked horizontal bars per target
 * base, with a 2px surface gap between segments and interior percentage
 * labels only where they fit.
 */
export function renderMixChart(rows: MixRow[], ariaLabel: string): string {
  const W = 700;
  const PL = 62;
  const PR = 14;
  const PT = 10;
  const PB = 26;
  const H = PT + PB + rows.length * 45;
  const innerW = W - PL - PR;
  const plotH = H - PT - PB;
  const band = plotH / rows.length;
  const barH = Math.min(20, band * 0.5);
  const GAP = 2;

  const parts: string[] = [];
  rows.forEach((row, i) => {
    const total = row.direct + row.relay;
    if (total === 0) return;
    const cy = PT + i * band + band / 2;
    const yTop = cy - barH / 2;
    const dPct = row.direct / total;
    const rPct = row.relay / total;
    const hasDirect = row.direct > 0;
    const hasRelay = row.relay > 0;
    // Only one non-zero segment means it spans the full width with no gap; a
    // zero-count segment renders nothing at all (no path, so nothing focusable
    // and nothing for the tooltip to announce as "0 (0%)").
    const gap = hasDirect && hasRelay ? GAP : 0;
    const dW = dPct * innerW - gap / 2;
    const rX = PL + dPct * innerW + gap / 2;
    const rW = rPct * innerW - gap / 2;

    parts.push(
      `<text x="${PL - 10}" y="${fmt(cy + 3.5)}" text-anchor="end" font-size="11" class="t-ink">${escapeHtml(row.label)}</text>`,
    );
    if (hasDirect) {
      // Direct is square-ended when a relay segment follows it, rounded when
      // it is the only segment (the bar's true right edge).
      parts.push(
        `<path d="${hbarPath(PL, yTop, Math.max(0.5, dW), barH, hasRelay ? 0 : 4)}" fill="var(--chart-1)" ${markAttrs(`${row.direct} (${Math.round(dPct * 100)}%)`, `${row.label} · direct throws`)}/>`,
      );
      if (dW > 34) {
        parts.push(
          `<text x="${fmt(PL + dW / 2)}" y="${fmt(cy + 3.5)}" text-anchor="middle" font-size="10.5" class="t-onfill" font-variant-numeric="tabular-nums">${Math.round(dPct * 100)}%</text>`,
        );
      }
    }
    if (hasRelay) {
      parts.push(
        `<path d="${hbarPath(rX, yTop, Math.max(0.5, rW), barH, 4)}" fill="var(--chart-2)" ${markAttrs(`${row.relay} (${Math.round(rPct * 100)}%)`, `${row.label} · relay chain`)}/>`,
      );
      if (rW > 34) {
        parts.push(
          `<text x="${fmt(rX + rW / 2)}" y="${fmt(cy + 3.5)}" text-anchor="middle" font-size="10.5" class="t-onfill" font-variant-numeric="tabular-nums">${Math.round(rPct * 100)}%</text>`,
        );
      }
    }
  });

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join("")}</svg>`;
}

// ---------------------------------------------------------------------------
// Cannon Update charts (batch 3): throw maps, beeswarm, position strips
// ---------------------------------------------------------------------------

/**
 * Fixed categorical palette slot per target base (design brief, never
 * cycled): Home/direct on slot 0, 2B/relay on slot 1, 3B on slot 2,
 * anything else (legacy 1B rows) on the slot-3 amber reserve. The single
 * encoding of the base→slot rule; baseColor maps it to the CSS tokens and
 * the share card maps it to theme.ts's CHART_SLOT_HEX.
 */
export function baseSlot(base: string): 0 | 1 | 2 | 3 {
  if (base === "Home") return 0;
  if (base === "2B") return 1;
  if (base === "3B") return 2;
  return 3;
}

/** CSS color expression for a target base's fixed palette slot. */
export function baseColor(base: string): string {
  return `var(--chart-${baseSlot(base) + 1})`;
}

/** Display order for base legends/keys: Home first, then the bags. */
export const BASE_DISPLAY_ORDER = ["Home", "2B", "3B", "1B"] as const;

/**
 * Deterministic PRNG (mulberry32) for the jittered arc/dot placements, so
 * the throw map and beeswarms render identically across requests and the
 * page tests can assert on stable markup.
 */
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw order for the season throw map: densest bases first, rare on top. */
const THROW_MAP_BASE_ORDER = ["2B", "Home", "3B", "1B"] as const;

/** Shared mph-axis domain for the velocity charts (real season min 30.3). */
const MPH_AXIS_MIN = 25;
const MPH_AXIS_MAX = 105;

/**
 * Quadratic-bow control point for a throw arc: perpendicular to the
 * origin→target line, signed away from the diamond's center so arcs
 * clear the infield. A throw line pointing straight at the center
 * (CF -> 2B or CF -> home) has no "away" side and defaults to bowing
 * right, fanning collinear arcs apart. Shared by the fielder mini map
 * and the share-card diamond.
 *
 * @param bowFactor - Bow magnitude as a fraction of the arc length.
 * @param minBow    - Smallest bow, so short arcs still read as arcs.
 * @param maxBow    - Largest bow, so long arcs stay inside the frame.
 */
export function arcControlPoint(
  origin: { x: number; y: number },
  target: { x: number; y: number },
  center: { x: number; y: number },
  bowFactor: number,
  minBow: number,
  maxBow: number,
): { cx: number; cy: number } {
  const mx = (origin.x + target.x) / 2;
  const my = (origin.y + target.y) / 2;
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const outward = px * (mx - center.x) + py * (my - center.y);
  const sign = outward !== 0 ? Math.sign(outward) : -1;
  const bow = Math.min(maxBow, Math.max(minBow, len * bowFactor)) * sign;
  return { cx: mx + px * bow, cy: my + py * bow };
}

/**
 * Season throw map: bird's-eye diamond with one thin low-opacity arc per
 * tracked assist, from the fielder's outfield zone to the target base,
 * stroke keyed to the base palette slot. Arcs are jittered around the
 * zone/base anchors with a deterministic PRNG so dense lanes read as
 * density instead of a single line.
 */
export function renderThrowMap(lanes: ThrowLane[], ariaLabel: string): string {
  const W = 400;
  const H = 360;
  const HOME = { x: 200, y: 312 };
  const FIRST = { x: 286, y: 226 };
  const SECOND = { x: 200, y: 140 };
  const THIRD = { x: 114, y: 226 };
  const TARGET: Record<string, { x: number; y: number }> = {
    Home: HOME,
    "1B": FIRST,
    "2B": SECOND,
    "3B": THIRD,
  };
  const ZONE: Record<string, { x: number; y: number }> = {
    LF: { x: 96, y: 78 },
    CF: { x: 200, y: 46 },
    RF: { x: 304, y: 78 },
  };
  const rnd = mulberry32(20260519);
  const parts: string[] = [];

  // Field: faint outfield fan + infield diamond + mound dot.
  parts.push(
    `<path d="M${HOME.x},${HOME.y} L${THIRD.x - 96},${THIRD.y - 116} A250,250 0 0 1 ${FIRST.x + 96},${FIRST.y - 116} Z" fill="color-mix(in oklch, var(--color-text) 3%, transparent)" stroke="var(--grid)" stroke-width="1"/>`,
    `<polygon points="${HOME.x},${HOME.y} ${FIRST.x},${FIRST.y} ${SECOND.x},${SECOND.y} ${THIRD.x},${THIRD.y}" fill="color-mix(in oklch, var(--color-text) 5%, transparent)" stroke="var(--grid)" stroke-width="1"/>`,
    `<circle cx="200" cy="226" r="3" fill="none" stroke="var(--grid)" stroke-width="1"/>`,
  );

  // Arcs: one per play, densest bases first so rarer ones read on top.
  const laneOrder = [...lanes].sort(
    (a, b) =>
      THROW_MAP_BASE_ORDER.indexOf(a.base as (typeof THROW_MAP_BASE_ORDER)[number]) -
      THROW_MAP_BASE_ORDER.indexOf(b.base as (typeof THROW_MAP_BASE_ORDER)[number]),
  );
  for (const lane of laneOrder) {
    const zone = ZONE[lane.position];
    const target = TARGET[lane.base];
    if (!zone || !target) continue;
    for (let i = 0; i < lane.count; i++) {
      const ox = zone.x + (rnd() - 0.5) * 74;
      const oy = zone.y + (rnd() - 0.5) * 46;
      const tx = target.x + (rnd() - 0.5) * 12;
      const ty = target.y + (rnd() - 0.5) * 12;
      // Perpendicular bow so overlapping arcs to the same base fan out.
      const mx = (ox + tx) / 2;
      const my = (oy + ty) / 2;
      const dx = tx - ox;
      const dy = ty - oy;
      const len = Math.hypot(dx, dy) || 1;
      const bow = (rnd() - 0.5) * 40;
      const cx = mx + (-dy / len) * bow;
      const cy = my + (dx / len) * bow;
      parts.push(
        `<path d="M${fmt(ox)},${fmt(oy)} Q${fmt(cx)},${fmt(cy)} ${fmt(tx)},${fmt(ty)}" fill="none" stroke="${baseColor(lane.base)}" stroke-width="1" stroke-linecap="round" opacity="0.13"/>`,
      );
    }
  }

  // Bases drawn on top of the arcs.
  const baseSquare = (x: number, y: number, home = false): string =>
    home
      ? `<path d="M${x},${y - 5} L${x + 5},${y} L${x},${y + 5} L${x - 5},${y} Z" fill="var(--color-bg)" stroke="var(--color-text-muted)" stroke-width="1.2"/>`
      : `<rect x="${x - 4.5}" y="${y - 4.5}" width="9" height="9" transform="rotate(45 ${x} ${y})" fill="var(--color-bg)" stroke="var(--color-text-muted)" stroke-width="1.2"/>`;
  parts.push(
    baseSquare(HOME.x, HOME.y, true),
    baseSquare(FIRST.x, FIRST.y),
    baseSquare(SECOND.x, SECOND.y),
    baseSquare(THIRD.x, THIRD.y),
  );

  // Base and zone labels.
  const baseLabel = (x: number, y: number, label: string, anchor: string): string =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="11" class="t-ink" font-weight="bold">${label}</text>`;
  parts.push(
    baseLabel(HOME.x, HOME.y + 22, "home", "middle"),
    baseLabel(FIRST.x + 12, FIRST.y + 4, "1b", "start"),
    baseLabel(SECOND.x, SECOND.y - 12, "2b", "middle"),
    baseLabel(THIRD.x - 12, THIRD.y + 4, "3b", "end"),
  );
  for (const [name, zone] of Object.entries(ZONE)) {
    parts.push(
      `<text x="${zone.x}" y="${zone.y - 22}" text-anchor="middle" font-size="12" class="t-ink" font-weight="bold" letter-spacing="1">${name}</text>`,
    );
  }

  return `<svg class="chart throwmap" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join("")}</svg>`;
}

/**
 * Fielder-profile mini throw map: one arc per (position, base) lane, arc
 * thickness scaled by throw count, palette by target base. Smaller and
 * calmer than the season map — a profile has one origin and a few lanes.
 */
export function renderMiniThrowMap(lanes: ThrowLane[], ariaLabel: string): string {
  const W = 220;
  const H = 210;
  const HOME = { x: 110, y: 178 };
  const FIRST = { x: 168, y: 120 };
  const SECOND = { x: 110, y: 62 };
  const THIRD = { x: 52, y: 120 };
  const CENTER = { x: 110, y: 120 };
  const TARGET: Record<string, { x: number; y: number }> = {
    Home: HOME,
    "1B": FIRST,
    "2B": SECOND,
    "3B": THIRD,
  };
  const ORIGIN: Record<string, { x: number; y: number }> = {
    LF: { x: 34, y: 44 },
    CF: { x: 110, y: 26 },
    RF: { x: 186, y: 44 },
  };
  const maxCount = Math.max(...lanes.map((lane) => lane.count), 1);
  const parts: string[] = [];

  parts.push(
    `<polygon points="${HOME.x},${HOME.y} ${FIRST.x},${FIRST.y} ${SECOND.x},${SECOND.y} ${THIRD.x},${THIRD.y}" fill="none" stroke="var(--grid)" stroke-width="1.5"/>`,
  );
  const baseRect = (p: { x: number; y: number }): string =>
    `<rect x="${p.x - 6}" y="${p.y - 6}" width="12" height="12" rx="1" transform="rotate(45 ${p.x} ${p.y})" fill="var(--color-bg)" stroke="var(--color-text-muted)" stroke-width="1.2"/>`;
  parts.push(baseRect(HOME), baseRect(FIRST), baseRect(SECOND), baseRect(THIRD));

  // Arcs, thickest (densest lane) first so thinner lanes stay visible.
  const byCount = [...lanes].sort((a, b) => b.count - a.count);
  const drawnOrigins = new Set<string>();
  for (const lane of byCount) {
    const origin = ORIGIN[lane.position];
    const target = TARGET[lane.base];
    if (!origin || !target) continue;
    drawnOrigins.add(lane.position);
    const width = 2 + 4 * (lane.count / maxCount);
    const { cx, cy } = arcControlPoint(origin, target, CENTER, 0.35, 12, 55);
    parts.push(
      `<path d="M${fmt(origin.x)} ${fmt(origin.y)} Q ${fmt(cx)} ${fmt(cy)} ${fmt(target.x)} ${fmt(target.y)}" fill="none" stroke="${baseColor(lane.base)}" stroke-width="${fmt(width)}" stroke-linecap="round" opacity="0.92"/>`,
    );
  }

  // Origin dot(s) + label(s) on top of the arcs.
  for (const position of drawnOrigins) {
    const origin = ORIGIN[position];
    if (!origin) continue;
    parts.push(
      `<circle cx="${origin.x}" cy="${origin.y}" r="4.5" fill="var(--color-text)"/>`,
      `<text x="${origin.x}" y="${origin.y - 10}" text-anchor="middle" font-size="9">${escapeHtml(position)}</text>`,
    );
  }

  parts.push(
    `<g font-size="8.5" text-anchor="middle">` +
      `<text x="110" y="199">home</text>` +
      `<text x="183" y="123">1B</text>` +
      `<text x="110" y="52">2B</text>` +
      `<text x="37" y="123">3B</text>` +
      `</g>`,
  );

  return `<svg class="viz" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join("")}</svg>`;
}

/**
 * X position on the shared mph axis. The velocity is clamped to the
 * fixed 25-105 domain so an out-of-range reading (a future 106 mph
 * outlier, or a junk sub-25 value) pins to the axis edge instead of
 * plotting outside the chart frame.
 */
function mphX(v: number, plotLeft: number, plotWidth: number): number {
  const clamped = Math.min(MPH_AXIS_MAX, Math.max(MPH_AXIS_MIN, v));
  return plotLeft + ((clamped - MPH_AXIS_MIN) / (MPH_AXIS_MAX - MPH_AXIS_MIN)) * plotWidth;
}

/** One beeswarm dot with a native <title> tooltip. */
function beeDot(
  cx: number,
  cy: number,
  r: number,
  t: MeasuredThrow,
  opacity: number,
): string {
  const title = `${escapeHtml(t.fielderName)} (${escapeHtml(t.position)}) &middot; ${mph(t.velocity)} mph &rarr; ${escapeHtml(t.base)}`;
  return `<circle class="bee" cx="${fmt(cx)}" cy="${fmt(cy)}" r="${r}" fill="${baseColor(t.base)}" opacity="${opacity}"><title>${title}</title></circle>`;
}

/**
 * Velocity spread beeswarm: one dot per measured throw on the mph axis,
 * colored by target base, with the 95 mph tier-bonus rule marked. Dots
 * carry native <title> tooltips.
 */
export function renderBeeswarm(throws: MeasuredThrow[], ariaLabel: string): string {
  const W = 700;
  const H = 150;
  const PL = 8;
  const PR = 8;
  const PT = 26;
  const PB = 26;
  const bot = H - PB;
  const plotW = W - PL - PR;
  const rnd = mulberry32(424242);
  const parts: string[] = [];

  for (const t of [30, 40, 50, 60, 70, 80, 90, 100]) {
    const x = mphX(t, PL, plotW);
    parts.push(
      `<line x1="${fmt(x)}" y1="${PT - 6}" x2="${fmt(x)}" y2="${bot}" stroke="var(--grid)" stroke-width="1"/>`,
      `<text x="${fmt(x)}" y="${bot + 15}" text-anchor="middle" font-size="9.5" font-variant-numeric="tabular-nums">${t}</text>`,
    );
  }
  parts.push(`<text x="${W - PR}" y="${bot + 15}" text-anchor="end" font-size="9.5" class="t-ink">mph</text>`);

  const ruleX = mphX(VELOCITY_THRESHOLD_MPH, PL, plotW);
  parts.push(
    `<line x1="${fmt(ruleX)}" y1="${PT - 12}" x2="${fmt(ruleX)}" y2="${bot}" stroke="var(--accent-color)" stroke-width="1" stroke-dasharray="3 3"/>`,
    `<text x="${fmt(ruleX)}" y="${PT - 16}" text-anchor="middle" font-size="9.5" class="t-ink">${VELOCITY_THRESHOLD_MPH} &middot; tier bonus</text>`,
  );

  const bandTop = PT + 2;
  const bandH = bot - 2 - bandTop;
  for (const t of throws) {
    const cx = mphX(t.velocity, PL, plotW);
    const cy = bandTop + rnd() * bandH;
    parts.push(beeDot(cx, cy, 2.6, t, 0.72));
  }

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join("")}</svg>`;
}

/** Outfield positions, top-to-bottom order for the position strips. */
export const STRIP_POSITIONS = ["LF", "CF", "RF"] as const;

/**
 * Arm-by-position strips: LF/CF/RF mini beeswarms stacked on one shared
 * mph axis, dots colored by target base, the 95 mph rule spanning all
 * rows. No legend — the base swatch legend is rendered by the caller once
 * per section group.
 */
export function renderPositionStrips(throws: MeasuredThrow[], ariaLabel: string): string {
  const W = 700;
  const PL = 40;
  const PR = 8;
  const PT = 10;
  const PB = 24;
  const ROW = 34;
  const H = PT + PB + STRIP_POSITIONS.length * ROW;
  const plotW = W - PL - PR;
  const rnd = mulberry32(9090);
  const parts: string[] = [];
  const bottomY = PT + STRIP_POSITIONS.length * ROW;

  for (const t of [30, 50, 70, 90, 100]) {
    const x = mphX(t, PL, plotW);
    parts.push(
      `<line x1="${fmt(x)}" y1="${PT}" x2="${fmt(x)}" y2="${bottomY}" stroke="var(--grid)" stroke-width="1"/>`,
      `<text x="${fmt(x)}" y="${bottomY + 15}" text-anchor="middle" font-size="9.5" font-variant-numeric="tabular-nums">${t}</text>`,
    );
  }
  parts.push(`<text x="${W - PR}" y="${bottomY + 15}" text-anchor="end" font-size="9.5" class="t-ink">mph</text>`);

  const ruleX = mphX(VELOCITY_THRESHOLD_MPH, PL, plotW);
  parts.push(
    `<line x1="${fmt(ruleX)}" y1="${PT}" x2="${fmt(ruleX)}" y2="${bottomY}" stroke="var(--accent-color)" stroke-width="1" stroke-dasharray="3 3"/>`,
  );

  STRIP_POSITIONS.forEach((position, i) => {
    const cyMid = PT + i * ROW + ROW / 2;
    parts.push(
      `<text x="${PL - 10}" y="${fmt(cyMid + 3.5)}" text-anchor="end" font-size="11" class="t-ink" font-weight="bold">${position}</text>`,
    );
    if (i > 0) {
      parts.push(
        `<line x1="${PL}" y1="${fmt(PT + i * ROW)}" x2="${W - PR}" y2="${fmt(PT + i * ROW)}" stroke="var(--grid)" stroke-width="1" opacity="0.5"/>`,
      );
    }
    const jitterH = ROW - 12;
    for (const t of throws) {
      if (t.position !== position) continue;
      const cx = mphX(t.velocity, PL, plotW);
      const cy = cyMid - jitterH / 2 + rnd() * jitterH;
      parts.push(beeDot(cx, cy, 2.4, t, 0.68));
    }
  });

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join("")}</svg>`;
}

/**
 * Fielder-profile velocity strip: the fielder's measured throws as accent
 * dots over a muted band spanning the league's measured range, on a
 * 30-105 mph axis. The hardest throw gets a ringed dot and a direct label.
 *
 * @param velocities - The fielder's measured velocities, ascending.
 * @param league     - League measured range (from queryVelocitySummary).
 */
export function renderVelocityStrip(
  velocities: number[],
  league: { min: number; max: number },
  ariaLabel: string,
): string {
  const W = 400;
  const H = 96;
  const AXMIN = 30;
  const AXMAX = 105;
  // Clamp to the axis domain, matching mphX's out-of-range policy.
  const x = (v: number): number => {
    const clamped = Math.min(AXMAX, Math.max(AXMIN, v));
    return 30 + ((clamped - AXMIN) / (AXMAX - AXMIN)) * 350;
  };
  const parts: string[] = [];

  // Muted league band.
  const bandX = x(league.min);
  const bandW = Math.max(0, x(league.max) - bandX);
  parts.push(
    `<rect x="${fmt(bandX)}" y="34" width="${fmt(bandW)}" height="16" rx="2" fill="color-mix(in oklch, var(--color-text) 9%, transparent)"/>`,
    `<text x="${fmt(bandX + bandW)}" y="28" text-anchor="end" font-size="8">league range</text>`,
  );

  // Axis + ticks.
  parts.push(`<line x1="30" y1="70" x2="380" y2="70" stroke="var(--grid)" stroke-width="1"/>`);
  for (const t of [40, 60, 80, 100]) {
    const tx = x(t);
    parts.push(
      `<line x1="${fmt(tx)}" y1="67" x2="${fmt(tx)}" y2="73" stroke="var(--grid)"/>`,
      `<text x="${fmt(tx)}" y="84" text-anchor="middle" font-size="8.5" font-variant-numeric="tabular-nums">${t}</text>`,
    );
  }
  parts.push(`<text x="392" y="73" text-anchor="start" font-size="8.5">mph</text>`);

  // The fielder's throws; the last (max) dot gets the ring and label.
  velocities.forEach((v, i) => {
    const cx = x(v);
    if (i === velocities.length - 1) {
      parts.push(
        `<circle cx="${fmt(cx)}" cy="42" r="4.8" fill="var(--accent-color)" stroke="var(--color-bg)" stroke-width="1.4"/>`,
        `<text x="${fmt(cx)}" y="20" text-anchor="middle" font-size="8.5" class="t-ink" font-weight="700">${mph(v)}</text>`,
        `<line x1="${fmt(cx)}" y1="23" x2="${fmt(cx)}" y2="34" stroke="var(--accent-color)" stroke-width="1"/>`,
      );
    } else {
      parts.push(`<circle cx="${fmt(cx)}" cy="42" r="4" fill="var(--accent-color)"/>`);
    }
  });

  return `<svg class="viz" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join("")}</svg>`;
}

/**
 * Renders a swatch legend (used when a chart plots two or more series).
 * Pass an extra class to restyle the swatches (e.g. "map-legend" turns
 * them into the thin line swatches echoing the throw-map arcs).
 */
export function renderChartLegend(
  items: Array<{ label: string; color: string }>,
  extraClass?: string,
): string {
  const spans = items
    .map(
      (item) =>
        `<span><i class="swatch" style="background:${item.color}"></i>${escapeHtml(item.label)}</span>`,
    )
    .join("");
  const className = extraClass ? `legend ${extraClass}` : "legend";
  return `<div class="${className}">${spans}</div>`;
}

/**
 * Renders the details-collapsed data-table twin every chart ships with.
 * Cell values are escaped here.
 */
export function renderDataTable(headers: string[], rows: string[][]): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("\n          ");
  return `<details>
      <summary>data table</summary>
      <div class="table-wrap">
        <table>
          <thead><tr>${head}</tr></thead>
          <tbody>
          ${body}
          </tbody>
        </table>
      </div>
    </details>`;
}

/** Shared tooltip container, appended once after the footer. */
export const TOOLTIP_HTML = `<div id="tt" hidden><span class="tt-v"></span> <span class="tt-l"></span></div>`;

/**
 * Inline vanilla JS that wires hover/focus tooltips onto .mark elements.
 * Mirrors the approved mockup's behavior: follows the pointer, flips near
 * viewport edges, and anchors above the mark on keyboard focus.
 */
export const TOOLTIP_SCRIPT = `<script>
(function () {
  "use strict";
  var tt = document.getElementById("tt");
  if (!tt) return;
  var ttV = tt.querySelector(".tt-v");
  var ttL = tt.querySelector(".tt-l");
  function place(x, y) {
    var r = tt.getBoundingClientRect();
    var nx = x + 14, ny = y + 14;
    if (nx + r.width > window.innerWidth - 8) nx = x - r.width - 14;
    if (ny + r.height > window.innerHeight - 8) ny = y - r.height - 14;
    tt.style.left = Math.max(8, nx) + "px";
    tt.style.top = Math.max(8, ny) + "px";
  }
  function set(node) {
    ttV.textContent = node.getAttribute("data-v");
    ttL.textContent = node.getAttribute("data-l");
    tt.hidden = false;
  }
  function hide() { tt.hidden = true; }
  Array.prototype.forEach.call(document.querySelectorAll(".mark"), function (node) {
    function show(e) { set(node); place(e.clientX, e.clientY); }
    function showFocus() {
      set(node);
      var b = node.getBoundingClientRect();
      place(b.left + b.width / 2 - 14, b.top - 14);
    }
    node.addEventListener("pointerenter", show);
    node.addEventListener("pointermove", show);
    node.addEventListener("pointerleave", hide);
    node.addEventListener("focus", showFocus);
    node.addEventListener("blur", hide);
  });
})();
</script>`;
