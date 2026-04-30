/**
 * Tests for the Slack notification module.
 *
 * Covers message building, tier filtering, and webhook delivery.
 * Uses a mock DetectedPlay factory and mocks globalThis.fetch for
 * webhook tests.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
  buildGameMessage,
  filterByMinTier,
  formatSituation,
  sendWebhook,
} from "../slack";
import type { DetectedPlay, Tier } from "../../types/play";
import type { Logger } from "../../logger";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMockPlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: 745433,
    playIndex: 42,
    date: "2024-04-09",
    fielderId: 676962,
    fielderName: "Cody Bellinger",
    fielderPosition: "CF",
    runnerId: 123456,
    runnerName: "Some Runner",
    targetBase: "3B",
    batterName: "Some Batter",
    inning: 7,
    halfInning: "top",
    awayScore: 2,
    homeScore: 1,
    awayTeam: "CHC",
    homeTeam: "SD",
    description: "Bellinger throws out runner at third base",
    creditChain: "CF -> 3B",
    tier: "high",
    outs: 1,
    runnersOn: "1st, 2nd",
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    ...overrides,
  };
}

/** A no-op logger that swallows all output. */
function makeSilentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// buildGameMessage
// ---------------------------------------------------------------------------

describe("buildGameMessage", () => {
  test("empty plays returns empty blocks", () => {
    const result = buildGameMessage([]);
    expect(result.blocks).toEqual([]);
  });

  test("single play produces header, context, divider, and play blocks", () => {
    const play = makeMockPlay();
    const result = buildGameMessage([play]);

    // First block: header with team matchup
    expect(result.blocks[0].type).toBe("header");
    expect(result.blocks[0].text?.text).toBe("CHC @ SD");

    // Second block: context with count and date
    expect(result.blocks[1].type).toBe("context");
    expect(result.blocks[1].elements?.[0]).toBeDefined();

    // Third block: divider before the play
    expect(result.blocks[2].type).toBe("divider");

    // Remaining blocks are the play detail blocks
    expect(result.blocks.length).toBeGreaterThan(3);
  });

  test("multiple plays from same game produce one header with all plays", () => {
    const plays = [
      makeMockPlay({ playIndex: 1 }),
      makeMockPlay({ playIndex: 2 }),
    ];
    const result = buildGameMessage(plays);

    // Should have exactly one header
    const headers = result.blocks.filter((b) => b.type === "header");
    expect(headers).toHaveLength(1);

    // Context should say "2 outfield assists"
    const contextBlock = result.blocks[1];
    const contextText =
      contextBlock.elements?.[0] && "text" in contextBlock.elements[0]
        ? contextBlock.elements[0].text
        : "";
    expect(contextText).toContain("2 outfield assists");

    // Two dividers, one per play
    const dividers = result.blocks.filter((b) => b.type === "divider");
    expect(dividers).toHaveLength(2);
  });

  test("video button included when videoUrl is present", () => {
    const play = makeMockPlay({
      videoUrl: "https://example.com/video.mp4",
      videoTitle: "Great throw",
    });
    const result = buildGameMessage([play]);

    const actionsBlock = result.blocks.find((b) => b.type === "actions");
    expect(actionsBlock).toBeDefined();

    const button = actionsBlock?.elements?.[0];
    expect(button).toBeDefined();
    if (button && "url" in button) {
      expect(button.url).toBe("https://example.com/video.mp4");
      expect(button.text.text).toBe("Great throw");
    }
  });

  test("no video button when videoUrl is null", () => {
    const play = makeMockPlay({ videoUrl: null });
    const result = buildGameMessage([play]);

    const actionsBlock = result.blocks.find((b) => b.type === "actions");
    expect(actionsBlock).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatSituation
// ---------------------------------------------------------------------------

describe("formatSituation", () => {
  test("formats outs with runners on base", () => {
    expect(formatSituation(1, "1st, 2nd")).toBe("1 out, R1 R2");
  });

  test("formats zero outs with bases empty", () => {
    expect(formatSituation(0, "")).toBe("0 out, bases empty");
  });

  test("formats two outs with bases loaded", () => {
    expect(formatSituation(2, "1st, 2nd, 3rd")).toBe("2 out, R1 R2 R3");
  });

  test("formats single runner on third", () => {
    expect(formatSituation(1, "3rd")).toBe("1 out, R3");
  });
});

// ---------------------------------------------------------------------------
// filterByMinTier
// ---------------------------------------------------------------------------

describe("filterByMinTier", () => {
  const plays: DetectedPlay[] = [
    makeMockPlay({ tier: "high", playIndex: 1 }),
    makeMockPlay({ tier: "medium", playIndex: 2 }),
    makeMockPlay({ tier: "low", playIndex: 3 }),
  ];

  test("undefined minTier returns all plays", () => {
    expect(filterByMinTier(plays, undefined)).toHaveLength(3);
  });

  test("'low' minTier returns all plays", () => {
    expect(filterByMinTier(plays, "low")).toHaveLength(3);
  });

  test("'medium' minTier returns only high and medium", () => {
    const result = filterByMinTier(plays, "medium");
    expect(result).toHaveLength(2);
    const tiers = result.map((p) => p.tier);
    expect(tiers).toContain("high");
    expect(tiers).toContain("medium");
    expect(tiers).not.toContain("low");
  });

  test("'high' minTier returns only high", () => {
    const result = filterByMinTier(plays, "high");
    expect(result).toHaveLength(1);
    expect(result[0].tier).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// sendWebhook
// ---------------------------------------------------------------------------

describe("sendWebhook", () => {
  const originalFetch = globalThis.fetch;

  function mockFetch(fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
    const mocked = Object.assign(mock(fn), { preconnect: mock((_url: string | URL) => {}) });
    globalThis.fetch = mocked;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("successful 200 response returns true", async () => {
    mockFetch(() =>
      Promise.resolve(new Response("ok", { status: 200 })),
    );

    const logger = makeSilentLogger();
    const result = await sendWebhook(
      "https://hooks.slack.com/test",
      { text: "hi" },
      logger,
    );

    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("non-2xx response retries and returns false after all attempts", async () => {
    mockFetch(() =>
      Promise.resolve(new Response("rate limited", { status: 429 })),
    );

    const logger = makeSilentLogger();
    const result = await sendWebhook(
      "https://hooks.slack.com/test",
      { text: "hi" },
      logger,
    );

    expect(result).toBe(false);
    // 3 attempts total (MAX_RETRIES = 3)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    // Logger should have warned about non-2xx and errored on final failure
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  test("network error retries and returns false after all attempts", async () => {
    mockFetch(() =>
      Promise.reject(new Error("network unreachable")),
    );

    const logger = makeSilentLogger();
    const result = await sendWebhook(
      "https://hooks.slack.com/test",
      { text: "hi" },
      logger,
    );

    expect(result).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  test("returns true on first success even if earlier attempts would fail", async () => {
    let callCount = 0;
    mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response("error", { status: 500 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const logger = makeSilentLogger();
    const result = await sendWebhook(
      "https://hooks.slack.com/test",
      { text: "hi" },
      logger,
    );

    expect(result).toBe(true);
    expect(callCount).toBe(2);
  });
});
