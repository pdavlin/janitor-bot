/**
 * Unit tests for the share-card SVG: the credit-chain row must never
 * collide with the velocity flex box, even for relay chains longer than
 * anything currently in the DB, and the card must stay self-contained.
 */

import { test, expect, describe } from "bun:test";
import { renderShareCardSvg } from "../share-card";
import type { StoredPlay } from "../../../types/play";

function makeStoredPlay(overrides: Partial<StoredPlay> = {}): StoredPlay {
  return {
    id: 268,
    createdAt: "2026-05-19T00:00:00.000Z",
    gamePk: 717401,
    playIndex: 42,
    date: "2026-05-19",
    fielderId: 695506,
    fielderName: "Jac Caglianone",
    fielderPosition: "RF",
    runnerId: 543807,
    runnerName: "Nick Sogard",
    targetBase: "Home",
    batterName: "Trea Turner",
    inning: 9,
    halfInning: "top",
    awayScore: 3,
    homeScore: 1,
    awayTeam: "BOS",
    homeTeam: "KC",
    description: "x",
    creditChain: "RF -> C",
    tier: "high",
    outs: 2,
    runnersOn: "1st, 2nd",
    isOverturned: false,
    playId: null,
    fetchStatus: null,
    videoUrl: null,
    videoTitle: null,
    throwVelocity: 102.7,
    throwVelocityStatus: "matched",
    ...overrides,
  };
}

/** The chain <text> row is the one anchored at y="492". */
function chainFontSize(svg: string): number {
  const match = svg.match(/<text x="60" y="492"[^>]*font-size="(\d+)"/);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

/** Estimated chain width: monospace 0.6em advance + 3px letter-spacing. */
function chainWidth(plainChain: string, fontSize: number): number {
  return plainChain.length * (fontSize * 0.6 + 3);
}

/** Left edge of the velocity flex box, and the clearance before it. */
const FLEX_X = 610;
const FLEX_GAP = 24;
const CHAIN_X = 60;

describe("renderShareCardSvg chain/flex layout", () => {
  test("a short direct chain keeps the full 40px font", () => {
    const svg = renderShareCardSvg(makeStoredPlay());
    expect(chainFontSize(svg)).toBe(40);
  });

  test("a 4-segment chain with velocity clears the flex box", () => {
    const chain = "LF -> SS -> 3B -> C";
    const svg = renderShareCardSvg(makeStoredPlay({ creditChain: chain }));
    const size = chainFontSize(svg);
    expect(CHAIN_X + chainWidth(chain, size)).toBeLessThanOrEqual(FLEX_X - FLEX_GAP);
    // The flex box renders at its fixed slot.
    expect(svg).toContain(`translate(${FLEX_X} 452)`);
    expect(svg).toContain("102.7");
  });

  test("a 6-segment chain (longest real chain + headroom) still fits", () => {
    const chain = "CF -> CF -> SS -> 3B -> SS -> C";
    const svg = renderShareCardSvg(makeStoredPlay({ creditChain: chain }));
    const size = chainFontSize(svg);
    expect(size).toBeLessThan(40);
    expect(CHAIN_X + chainWidth(chain, size)).toBeLessThanOrEqual(FLEX_X - FLEX_GAP);
  });

  test("without velocity the chain may use the wider budget and no flex box renders", () => {
    const chain = "CF -> CF -> SS -> 3B -> SS -> C";
    const svg = renderShareCardSvg(
      makeStoredPlay({ creditChain: chain, throwVelocity: null }),
    );
    const size = chainFontSize(svg);
    expect(svg).not.toContain(`translate(${FLEX_X} 452)`);
    // Fits inside the frame short of the diamond group.
    expect(CHAIN_X + chainWidth(chain, size)).toBeLessThanOrEqual(840);
  });

  test("stays self-contained (no CSS custom-property references)", () => {
    const svg = renderShareCardSvg(makeStoredPlay());
    expect(svg).not.toContain("var(--");
  });
});
