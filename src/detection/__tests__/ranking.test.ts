/**
 * Tests for the calculateTier ranking function.
 *
 * Scoring breakdown:
 *   Target base:  Home = 4, 3B = 3, 2B = 1
 *   Direct throw (2 segments): 2
 *   Video available: 1
 *   Overturned (replay reversal): -2
 *
 * Tier thresholds: 5+ = high, 3-4 = medium, 0-2 = low
 */

import { test, expect, describe } from "bun:test";
import { calculateTier } from "../ranking";

describe("calculateTier", () => {
  test("high tier - direct throw to home plate: Home(4) + direct(2) = 6", () => {
    const tier = calculateTier({
      targetBase: "Home",
      creditChain: "RF -> C",
      hasVideo: false,
      isOverturned: false,
    });
    expect(tier).toBe("high");
  });

  test("high tier - direct throw to 3B: 3B(3) + direct(2) = 5", () => {
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> 3B",
      hasVideo: false,
      isOverturned: false,
    });
    expect(tier).toBe("high");
  });

  test("medium tier - relay throw to home plate: Home(4) + relay(0) = 4", () => {
    const tier = calculateTier({
      targetBase: "Home",
      creditChain: "RF -> SS -> C",
      hasVideo: false,
      isOverturned: false,
    });
    expect(tier).toBe("medium");
  });

  test("medium tier - relay throw to 3B: 3B(3) + relay(0) = 3", () => {
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> SS -> 3B",
      hasVideo: false,
      isOverturned: false,
    });
    expect(tier).toBe("medium");
  });

  test("medium tier - direct throw to 2B: 2B(1) + direct(2) = 3", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "CF -> 2B",
      hasVideo: false,
      isOverturned: false,
    });
    expect(tier).toBe("medium");
  });

  test("low tier - relay throw to 2B: 2B(1) + relay(0) = 1", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "RF -> SS -> 2B",
      hasVideo: false,
      isOverturned: false,
    });
    expect(tier).toBe("low");
  });

  test("video bonus promotes relay to home from medium to high: Home(4) + relay(0) + video(1) = 5", () => {
    const tier = calculateTier({
      targetBase: "Home",
      creditChain: "RF -> SS -> C",
      hasVideo: true,
      isOverturned: false,
    });
    expect(tier).toBe("high");
  });

  test("video bonus promotes relay to 2B from low to low: 2B(1) + relay(0) + video(1) = 2", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "RF -> SS -> 2B",
      hasVideo: true,
      isOverturned: false,
    });
    expect(tier).toBe("low");
  });

  test("video bonus promotes relay to 3B from medium to medium: 3B(3) + relay(0) + video(1) = 4", () => {
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> SS -> 3B",
      hasVideo: true,
      isOverturned: false,
    });
    expect(tier).toBe("medium");
  });

  test("overturn penalty drops direct throw to 3B from high to medium: 3B(3) + direct(2) - overturn(2) = 3", () => {
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> 3B",
      hasVideo: false,
      isOverturned: true,
    });
    expect(tier).toBe("medium");
  });

  test("overturn penalty drops direct throw to 2B from medium to low: 2B(1) + direct(2) - overturn(2) = 1", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "CF -> 2B",
      hasVideo: false,
      isOverturned: true,
    });
    expect(tier).toBe("low");
  });

  test("overturn penalty still leaves direct throw home in high: Home(4) + direct(2) - overturn(2) = 4 -> medium", () => {
    const tier = calculateTier({
      targetBase: "Home",
      creditChain: "RF -> C",
      hasVideo: false,
      isOverturned: true,
    });
    expect(tier).toBe("medium");
  });

  test("overturn penalty with video offsets partially: 3B(3) + direct(2) + video(1) - overturn(2) = 4 -> medium", () => {
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> 3B",
      hasVideo: true,
      isOverturned: true,
    });
    expect(tier).toBe("medium");
  });
});
