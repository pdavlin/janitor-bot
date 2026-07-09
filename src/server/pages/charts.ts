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

import { escapeHtml } from "./components";

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

/**
 * Charts 2 and 3: horizontal bars with a left label + swatch dot per row
 * and a direct count label at each bar tip.
 */
export function renderHBarChart(
  rows: ChartRow[],
  unitLabel: string,
  ariaLabel: string,
): string {
  const W = 700;
  const PL = 62;
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
      `<text x="20" y="${fmt(cy + 3.5)}" text-anchor="start" font-size="11" class="t-ink">${escapeHtml(row.label)}</text>`,
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
    const dW = dPct * innerW - GAP / 2;
    const rX = PL + dPct * innerW + GAP / 2;
    const rW = rPct * innerW - GAP / 2;

    parts.push(
      `<text x="${PL - 10}" y="${fmt(cy + 3.5)}" text-anchor="end" font-size="11" class="t-ink">${escapeHtml(row.label)}</text>`,
      `<path d="${hbarPath(PL, yTop, Math.max(0.5, dW), barH, 0)}" fill="var(--chart-1)" ${markAttrs(`${row.direct} (${Math.round(dPct * 100)}%)`, `${row.label} · direct throws`)}/>`,
      `<path d="${hbarPath(rX, yTop, Math.max(0.5, rW), barH, 4)}" fill="var(--chart-2)" ${markAttrs(`${row.relay} (${Math.round(rPct * 100)}%)`, `${row.label} · relay chain`)}/>`,
    );
    if (dW > 34) {
      parts.push(
        `<text x="${fmt(PL + dW / 2)}" y="${fmt(cy + 3.5)}" text-anchor="middle" font-size="10.5" class="t-onfill" font-variant-numeric="tabular-nums">${Math.round(dPct * 100)}%</text>`,
      );
    }
    if (rW > 34) {
      parts.push(
        `<text x="${fmt(rX + rW / 2)}" y="${fmt(cy + 3.5)}" text-anchor="middle" font-size="10.5" class="t-onfill" font-variant-numeric="tabular-nums">${Math.round(rPct * 100)}%</text>`,
      );
    }
  });

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join("")}</svg>`;
}

/** Renders a swatch legend (used when a chart plots two or more series). */
export function renderChartLegend(items: Array<{ label: string; color: string }>): string {
  const spans = items
    .map(
      (item) =>
        `<span><i class="swatch" style="background:${item.color}"></i>${escapeHtml(item.label)}</span>`,
    )
    .join("");
  return `<div class="legend">${spans}</div>`;
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
