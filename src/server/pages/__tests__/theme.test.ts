/**
 * Regression tests for the shared theme and page shell.
 *
 * Guards the visual-QA defects found in batch 1:
 * 1. The breakout grid silently collapsed because the space-scale clamp()
 *    sums lacked whitespace around the + operator - invalid CSS math in a
 *    custom property fails at computed-value time and drops every rule
 *    that consumes it. Lint the CSS for glued arithmetic operators.
 * 2. Grid rows stretched to fill tall viewports; main must pack rows with
 *    align-content: start while the sticky footer keeps using body flex.
 * 3. svg.chart text { fill: ... } overrides presentational fill
 *    attributes, so emphasised chart labels need classed rules.
 * Also asserts every page renders inside the same shell/grid structure.
 */

import { describe, test, expect } from "bun:test";
import { THEME_CSS } from "../theme";
import { renderPage } from "../shell";
import { renderHomePage } from "../home";
import { renderHighlightsPage } from "../highlights";
import { renderSeasonPage } from "../season";
import { renderAboutPage } from "../about";

describe("THEME_CSS", () => {
  test("has no CSS math with a + glued to its operands", () => {
    // "1.46rem+.19vw" is invalid CSS math and silently kills every rule
    // consuming the custom property. + must be surrounded by whitespace.
    expect(THEME_CSS).not.toMatch(/(?:\d|rem|em|px|vw|vh|%)\+/);
    expect(THEME_CSS).not.toMatch(/\+(?:\d|\.)/);
  });

  test("space tokens parse as valid math (spaced operators)", () => {
    expect(THEME_CSS).toContain("--space_m:   clamp(1.5rem, 1.46rem + .19vw, 1.6875rem);");
    expect(THEME_CSS).toContain("--space_xl:  clamp(3rem, 2.93rem + .37vw, 3.375rem);");
  });

  test("main uses the three-track breakout grid and packs rows to start", () => {
    expect(THEME_CSS).toContain("main { display: grid; align-content: start;");
    expect(THEME_CSS).toContain(
      "[content-start] min(100% - 2*var(--page-gutters), var(--page-max)) [content-end]",
    );
    expect(THEME_CSS).toContain("main > * { grid-column: content; }");
  });

  test("keeps the sticky-footer flex column", () => {
    expect(THEME_CSS).toContain("body { min-height: 100vh; display: flex; flex-direction: column; }");
    expect(THEME_CSS).toContain("main { flex: 1 0 auto;");
  });

  test("defines classed fills for emphasised chart labels", () => {
    expect(THEME_CSS).toContain("svg.chart text.t-ink { fill: var(--color-text); }");
    expect(THEME_CSS).toContain("svg.chart text.t-onfill { fill: var(--base_07); }");
  });
});

describe("page shell sharing", () => {
  const pages: Array<[string, string]> = [
    [
      "home",
      renderHomePage({
        totalPlays: 0,
        highTierCount: 0,
        oldestPlay: null,
        newestPlay: null,
        recentPlays: [],
      }),
    ],
    [
      "highlights",
      renderHighlightsPage({ plays: [], total: 0, offset: 0, filters: {}, teams: [] }),
    ],
    [
      "season",
      renderSeasonPage({
        totalPlays: 0,
        oldestPlay: null,
        newestPlay: null,
        weekly: [],
        tiers: [],
        bases: [],
        mix: [],
        leaders: [],
        teamsBurned: [],
      }),
    ],
    ["about", renderAboutPage()],
  ];

  test("every page embeds the shared theme and shell structure", () => {
    for (const [name, html] of pages) {
      expect(html, name).toContain('<main class="flow">');
      expect(html, name).toContain('class="site-header"');
      expect(html, name).toContain('class="site-footer"');
      // the same single grid definition, embedded once
      expect(html.split("main { display: grid; align-content: start;").length - 1, name).toBe(1);
    }
  });
});

describe("chart label fills", () => {
  test("season chart labels use classed fills, not overridden attributes", () => {
    const html = renderSeasonPage({
      totalPlays: 10,
      oldestPlay: "2026-04-06",
      newestPlay: "2026-05-04",
      weekly: [
        { weekStart: "2026-04-06", count: 4 },
        { weekStart: "2026-04-13", count: 6 },
      ],
      tiers: [
        { tier: "high", count: 4 },
        { tier: "medium", count: 4 },
        { tier: "low", count: 2 },
      ],
      bases: [
        { base: "Home", count: 6 },
        { base: "2B", count: 4 },
      ],
      mix: [
        { base: "Home", direct: 4, relay: 2 },
        { base: "2B", direct: 1, relay: 3 },
      ],
      leaders: [],
      teamsBurned: [],
    });
    expect(html).toContain('class="t-onfill"');
    expect(html).toContain('class="t-ink"');
    // no <text> node may carry a raw fill attribute the stylesheet overrides
    expect(html).not.toMatch(/<text [^>]*fill="var\(/);
  });
});
