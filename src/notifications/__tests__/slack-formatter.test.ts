/**
 * Tests for slack-formatter (Block Kit builders + tier filtering).
 *
 * Pure formatter tests live here. Transport (sendWebhook, postMessage,
 * chat.update) is exercised in slack-client.test.ts.
 */

import { test, expect, describe } from "bun:test";
import {
  buildGameMessage,
  buildThreadReplyMessage,
  filterByMinTier,
  formatSituation,
} from "../slack-formatter";
import type { DetectedPlay, StoredPlay } from "../../types/play";
import type { BackfillSuccessEvent } from "../../daemon/backfill";

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

function makeStoredPlay(overrides: Partial<StoredPlay> = {}): StoredPlay {
  return {
    ...makeMockPlay(),
    id: 1,
    createdAt: "2024-04-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildGameMessage", () => {
  test("empty plays returns empty blocks", () => {
    const result = buildGameMessage([]);
    expect(result.blocks).toEqual([]);
  });

  test("single play produces header, context, divider, and play blocks", () => {
    const play = makeMockPlay();
    const result = buildGameMessage([play]);

    expect(result.blocks[0].type).toBe("header");
    expect(result.blocks[0].text?.text).toBe("CHC @ SD");
    expect(result.blocks[1].type).toBe("context");
    expect(result.blocks[1].elements?.[0]).toBeDefined();
    expect(result.blocks[2].type).toBe("divider");
    expect(result.blocks.length).toBeGreaterThan(3);
  });

  test("multiple plays from same game produce one header with all plays", () => {
    const plays = [
      makeMockPlay({ playIndex: 1 }),
      makeMockPlay({ playIndex: 2 }),
    ];
    const result = buildGameMessage(plays);

    const headers = result.blocks.filter((b) => b.type === "header");
    expect(headers).toHaveLength(1);

    const contextBlock = result.blocks[1];
    const contextText =
      contextBlock.elements?.[0] && "text" in contextBlock.elements[0]
        ? contextBlock.elements[0].text
        : "";
    expect(contextText).toContain("2 outfield assists");

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

describe("buildThreadReplyMessage", () => {
  test("includes fielder, position, target base, and watch button", () => {
    const play = makeStoredPlay({
      fielderName: "Aaron Judge",
      fielderPosition: "RF",
      targetBase: "Home",
    });
    const event: BackfillSuccessEvent = {
      gamePk: play.gamePk,
      playIndex: play.playIndex,
      videoUrl: "https://example.com/rescued.mp4",
      videoTitle: "Late video",
    };

    const payload = buildThreadReplyMessage(play, event);
    expect(payload.blocks).toHaveLength(2);

    const section = payload.blocks[0];
    const sectionText = section.text && "text" in section.text ? section.text.text : "";
    expect(sectionText).toContain("Aaron Judge");
    expect(sectionText).toContain("RF");
    expect(sectionText).toContain("Home");
    expect(sectionText).toContain("Video now available");

    const action = payload.blocks[1];
    expect(action.type).toBe("actions");
    const button = action.elements?.[0];
    if (button && "url" in button) {
      expect(button.url).toBe("https://example.com/rescued.mp4");
      expect(button.action_id).toBe(
        `backfill_video_${play.gamePk}_${play.playIndex}`,
      );
    }
  });
});

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
