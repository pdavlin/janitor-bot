/**
 * Unit tests for the inline SVG chart helpers: the mix chart's handling of
 * zero-count segments (no phantom focusable slivers) and the hbar chart's
 * label-derived left gutter (long row labels must not run under the bars).
 */

import { test, expect, describe } from "bun:test";
import { renderHBarChart, renderMixChart, type ChartRow, type MixRow } from "../charts";

/** Counts non-overlapping occurrences of needle in haystack. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("renderMixChart", () => {
  test("a zero-count segment renders no mark at all", () => {
    const rows: MixRow[] = [{ label: "Home", direct: 5, relay: 0 }];
    const svg = renderMixChart(rows, "test");

    // Exactly one focusable mark (the direct segment); the relay 0 is skipped.
    expect(countOf(svg, 'class="mark"')).toBe(1);
    // Nothing announces the empty segment as "0 (0%)".
    expect(svg).not.toContain("0 (0%)");
    expect(svg).toContain("direct throws");
    expect(svg).not.toContain("relay chain");
  });

  test("the lone segment spans the full width with a rounded end", () => {
    const rows: MixRow[] = [{ label: "Home", direct: 0, relay: 4 }];
    const svg = renderMixChart(rows, "test");

    expect(countOf(svg, 'class="mark"')).toBe(1);
    expect(svg).toContain("relay chain");
    expect(svg).not.toContain("direct throws");
    // 100% label present for the single full segment.
    expect(svg).toContain(">100%</text>");
  });

  test("both non-zero segments each render a mark", () => {
    const rows: MixRow[] = [{ label: "2B", direct: 3, relay: 1 }];
    const svg = renderMixChart(rows, "test");
    expect(countOf(svg, 'class="mark"')).toBe(2);
  });

  test("a fully empty row renders nothing", () => {
    const rows: MixRow[] = [{ label: "3B", direct: 0, relay: 0 }];
    const svg = renderMixChart(rows, "test");
    expect(countOf(svg, 'class="mark"')).toBe(0);
  });
});

describe("renderHBarChart", () => {
  /**
   * Extracts the bars' shared left edge (the derived gutter) from the
   * first mark path, which starts with `M<x>,`.
   */
  function barStartX(svg: string): number {
    const match = svg.match(/<path d="M(\d+(?:\.\d+)?),/);
    expect(match).not.toBeNull();
    return Number(match![1]);
  }

  /** Estimated right edge of an 11px monospace label starting at x=20. */
  function labelEndX(label: string): number {
    return 20 + label.length * 6.6;
  }

  function makeRows(labels: string[]): ChartRow[] {
    return labels.map((label, i) => ({
      label,
      value: i + 1,
      color: "var(--chart-1)",
    }));
  }

  test("bars start past the longest row label", () => {
    // The /ops fetch-status label set that clipped under the fixed gutter.
    const svg = renderHBarChart(makeRows(["success", "unfetched", "no video"]), "plays", "test");
    expect(barStartX(svg)).toBeGreaterThan(labelEndX("unfetched"));
  });

  test("short label sets keep a compact gutter", () => {
    // Season-style labels must not inherit a wide ops-sized gutter.
    const short = barStartX(renderHBarChart(makeRows(["high", "medium", "low"]), "plays", "test"));
    const long = barStartX(renderHBarChart(makeRows(["success", "unfetched", "no video"]), "plays", "test"));
    expect(short).toBeGreaterThan(labelEndX("medium"));
    expect(short).toBeLessThan(long);
    expect(short).toBeLessThanOrEqual(80);
  });

  test("a pathological label cannot consume the plot area", () => {
    const svg = renderHBarChart(makeRows(["x".repeat(120)]), "plays", "test");
    // Gutter clamps to a third of the 700-unit width.
    expect(barStartX(svg)).toBeLessThanOrEqual(233);
  });
});
