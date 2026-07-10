/**
 * Unit tests for the inline SVG chart helpers, focused on the mix chart's
 * handling of zero-count segments (no phantom focusable slivers).
 */

import { test, expect, describe } from "bun:test";
import { renderMixChart, type MixRow } from "../charts";

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
