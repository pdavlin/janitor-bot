/**
 * Unit tests for the shared HTML building blocks: escaping, the play card's
 * escaping of DB-sourced context, its video-link scheme guard, and the
 * short-date fallback escaping.
 */

import { test, expect, describe } from "bun:test";
import { escapeHtml, formatShortDate, playCard } from "../components";
import type { StoredPlay } from "../../../types/play";

function makeStoredPlay(overrides: Partial<StoredPlay> = {}): StoredPlay {
  return {
    id: 1,
    createdAt: "2026-06-23T00:00:00.000Z",
    gamePk: 717401,
    playIndex: 42,
    date: "2026-06-23",
    fielderId: 641355,
    fielderName: "Andy Pages",
    fielderPosition: "CF",
    runnerId: 543807,
    runnerName: "Austin Martin",
    targetBase: "Home",
    batterName: "Trea Turner",
    inning: 3,
    halfInning: "bottom",
    awayScore: 2,
    homeScore: 1,
    awayTeam: "LAD",
    homeTeam: "MIN",
    description: "x",
    creditChain: "CF -> C",
    tier: "high",
    outs: 2,
    runnersOn: "1st",
    isOverturned: false,
    playId: null,
    fetchStatus: null,
    videoUrl: "https://example.com/clip.mp4",
    videoTitle: "clip",
    throwVelocity: null,
    throwVelocityStatus: null,
    ...overrides,
  };
}

describe("escapeHtml", () => {
  test("escapes the five HTML-significant characters (Bun entity forms)", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#x27;");
  });
});

describe("formatShortDate", () => {
  test("formats an ISO date to a short label", () => {
    expect(formatShortDate("2026-03-10")).toBe("Mar 10");
  });

  test("escapes a non-ISO fallback so it is safe as pre-escaped HTML", () => {
    expect(formatShortDate("<b>oops</b>")).toBe("&lt;b&gt;oops&lt;/b&gt;");
  });
});

describe("playCard", () => {
  test("escapes a DB-sourced runners-on context string", () => {
    const html = playCard(makeStoredPlay({ runnersOn: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("renders the watch link for an http(s) video URL", () => {
    const html = playCard(makeStoredPlay({ videoUrl: "https://example.com/x.mp4" }));
    expect(html).toContain('<a class="watch" href="https://example.com/x.mp4">');
    expect(html).not.toContain("no video");
  });

  test("falls back to the no-video state for a non-http scheme", () => {
    const html = playCard(makeStoredPlay({ videoUrl: "javascript:alert(1)" }));
    expect(html).toContain('<span class="no-video">no video</span>');
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain('class="watch"');
  });

  test("falls back to the no-video state for an unparseable URL", () => {
    const html = playCard(makeStoredPlay({ videoUrl: "not a url" }));
    expect(html).toContain('<span class="no-video">no video</span>');
    expect(html).not.toContain('class="watch"');
  });
});
