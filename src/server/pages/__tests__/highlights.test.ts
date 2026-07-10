/**
 * Unit tests for the highlights page's pager boundary and empty-state copy.
 *
 * These cover the page-aligned paging clamp: the older link must vanish at
 * HIGHLIGHTS_MAX_OFFSET instead of pointing past it (which the offset parser
 * would clamp back, looping on the same page), and the empty state must
 * distinguish "paged too far back" from "nothing tracked yet".
 */

import { test, expect, describe } from "bun:test";
import {
  renderHighlightsPage,
  HIGHLIGHTS_PAGE_SIZE,
  HIGHLIGHTS_MAX_OFFSET,
  type HighlightsPageData,
} from "../highlights";

function makeData(overrides: Partial<HighlightsPageData> = {}): HighlightsPageData {
  return {
    plays: [],
    total: 0,
    offset: 0,
    filters: {},
    teams: ["LAD", "MIN"],
    ...overrides,
  };
}

describe("HIGHLIGHTS_MAX_OFFSET", () => {
  test("is the largest page-aligned offset at or below 10000", () => {
    expect(HIGHLIGHTS_MAX_OFFSET % HIGHLIGHTS_PAGE_SIZE).toBe(0);
    expect(HIGHLIGHTS_MAX_OFFSET).toBeLessThanOrEqual(10000);
    expect(HIGHLIGHTS_MAX_OFFSET + HIGHLIGHTS_PAGE_SIZE).toBeGreaterThan(10000);
  });
});

describe("pager older-link boundary", () => {
  test("hides the older link at the clamp even when more rows exist", () => {
    // A huge total would normally keep the older link, but the clamp wins.
    const html = renderHighlightsPage(
      makeData({ offset: HIGHLIGHTS_MAX_OFFSET, total: 1_000_000, plays: [] }),
    );
    expect(html).not.toContain("older &rarr;");
    // The newer link still works so a reader can climb back out.
    expect(html).toContain("&larr; newer");
  });

  test("shows the older link one page below the clamp", () => {
    const html = renderHighlightsPage(
      makeData({
        offset: HIGHLIGHTS_MAX_OFFSET - HIGHLIGHTS_PAGE_SIZE,
        total: 1_000_000,
        plays: [],
      }),
    );
    expect(html).toContain(`offset=${HIGHLIGHTS_MAX_OFFSET}`);
    expect(html).toContain("older &rarr;");
  });
});

describe("empty-state copy", () => {
  test("first page, no filters -> nothing tracked yet", () => {
    const html = renderHighlightsPage(makeData({ offset: 0 }));
    expect(html).toContain("no plays tracked yet.");
  });

  test("first page with filters -> filters too narrow", () => {
    const html = renderHighlightsPage(makeData({ offset: 0, filters: { tier: "high" } }));
    expect(html).toContain("no plays match these filters.");
  });

  test("paged past the last row -> nothing this far back", () => {
    const html = renderHighlightsPage(
      makeData({ offset: HIGHLIGHTS_PAGE_SIZE, total: 3 }),
    );
    expect(html).toContain("nothing this far back.");
    expect(html).not.toContain("no plays tracked yet.");
    // The newer link is preserved so the reader is not stranded.
    expect(html).toContain("&larr; newer");
  });
});
