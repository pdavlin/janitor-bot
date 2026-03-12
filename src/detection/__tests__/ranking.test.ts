/**
 * Tests for the calculateTier ranking function.
 *
 * Scoring breakdown:
 *   Target base:  Home = 4, 3B = 3, 2B = 1
 *   Direct throw (2 segments): 2
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
    });
    expect(tier).toBe("high");
  });

  test("high tier - direct throw to 3B: 3B(3) + direct(2) = 5", () => {
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> 3B",
    });
    expect(tier).toBe("high");
  });

  test("medium tier - relay throw to home plate: Home(4) + relay(0) = 4", () => {
    const tier = calculateTier({
      targetBase: "Home",
      creditChain: "RF -> SS -> C",
    });
    expect(tier).toBe("medium");
  });

  test("medium tier - relay throw to 3B: 3B(3) + relay(0) = 3", () => {
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> SS -> 3B",
    });
    expect(tier).toBe("medium");
  });

  test("medium tier - direct throw to 2B: 2B(1) + direct(2) = 3", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "CF -> 2B",
    });
    expect(tier).toBe("medium");
  });

  test("low tier - relay throw to 2B: 2B(1) + relay(0) = 1", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "RF -> SS -> 2B",
    });
    expect(tier).toBe("low");
  });
});
