/**
 * Tests for the calculateTier ranking function.
 *
 * Scoring breakdown:
 *   Target base:  Home = 4, 3B = 3, 2B = 1
 *   Direct throw (2 segments): 2
 *   Relay chain (3+ segments): -2
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

  test("low tier - relay throw to home plate: Home(4) + relay(-2) = 2", () => {
    const tier = calculateTier({
      targetBase: "Home",
      creditChain: "RF -> SS -> C",
      hasVideo: false,
      isOverturned: false,
    });
    expect(tier).toBe("low");
  });

  test("low tier - relay throw to 3B: 3B(3) + relay(-2) = 1", () => {
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> SS -> 3B",
      hasVideo: false,
      isOverturned: false,
    });
    expect(tier).toBe("low");
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

  test("video bonus leaves relay to home at medium: Home(4) + relay(-2) + video(1) = 3", () => {
    const tier = calculateTier({
      targetBase: "Home",
      creditChain: "RF -> SS -> C",
      hasVideo: true,
      isOverturned: false,
    });
    expect(tier).toBe("medium");
  });

  test("video bonus leaves relay to 2B at low: 2B(1) + relay(-2) + video(1) = 0", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "RF -> SS -> 2B",
      hasVideo: true,
      isOverturned: false,
    });
    expect(tier).toBe("low");
  });

  test("video bonus leaves relay to 3B at low: 3B(3) + relay(-2) + video(1) = 2", () => {
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> SS -> 3B",
      hasVideo: true,
      isOverturned: false,
    });
    expect(tier).toBe("low");
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

  // -----------------------------------------------------------------------
  // Relay penalty (3+ segment chains). Originally 4+ only (run #7 finding 20);
  // extended to 3+ after a six-week engagement aggregate showed all relays are
  // unloved (0.00-0.05 fire/play) and absorb most trash votes.
  // -----------------------------------------------------------------------

  test("long relay (4 segments) drops 3B from medium to low: 3B(3) + longRelay(-2) = 1", () => {
    // Play 333 (LF -> SS -> C -> 3B, CWS@PHI) drew the week's only trash vote.
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> SS -> C -> 3B",
      hasVideo: false,
      isOverturned: false,
    });
    expect(tier).toBe("low");
  });

  test("long relay (4 segments) with video still drops 3B to low: 3B(3) + video(1) + longRelay(-2) = 2", () => {
    // The realistic play-333 shape: even with a matched video it lands low.
    const tier = calculateTier({
      targetBase: "3B",
      creditChain: "LF -> SS -> C -> 3B",
      hasVideo: true,
      isOverturned: false,
    });
    expect(tier).toBe("low");
  });

  test("long relay (4 segments) drops Home from high to medium: Home(4) + video(1) + longRelay(-2) = 3", () => {
    const tier = calculateTier({
      targetBase: "Home",
      creditChain: "RF -> 1B -> SS -> C",
      hasVideo: true,
      isOverturned: false,
    });
    expect(tier).toBe("medium");
  });

  test("single-cutoff relay (3 segments) IS penalized: relay to home drops to low", () => {
    // The six-week aggregate reversed run #7 finding 17: a one-intermediary
    // cutoff to Home is penalized like any other relay. Home(4) + relay(-2) = 2.
    const tier = calculateTier({
      targetBase: "Home",
      creditChain: "RF -> SS -> C",
      hasVideo: false,
      isOverturned: false,
    });
    expect(tier).toBe("low");
  });

  test("direct throws are unaffected by the relay penalty", () => {
    expect(
      calculateTier({
        targetBase: "Home",
        creditChain: "CF -> C",
        hasVideo: false,
        isOverturned: false,
      }),
    ).toBe("high");
    expect(
      calculateTier({
        targetBase: "3B",
        creditChain: "RF -> 3B",
        hasVideo: false,
        isOverturned: false,
      }),
    ).toBe("high");
  });

  // -----------------------------------------------------------------------
  // Throw velocity bonus (FR-1.10: absent velocity contributes 0)
  // -----------------------------------------------------------------------

  test("absent velocity (undefined) contributes 0: direct to 2B stays medium", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "CF -> 2B",
      hasVideo: false,
      isOverturned: false,
      throwVelocity: undefined,
    });
    expect(tier).toBe("medium");
  });

  test("absent velocity (null) contributes 0: direct to 2B stays medium", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "CF -> 2B",
      hasVideo: false,
      isOverturned: false,
      throwVelocity: null,
    });
    expect(tier).toBe("medium");
  });

  test("low velocity (< 95) contributes 0: direct to 2B stays medium", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "CF -> 2B",
      hasVideo: false,
      isOverturned: false,
      throwVelocity: 88.5,
    });
    expect(tier).toBe("medium");
  });

  test("high velocity (>= 95) adds +1: direct to 2B (3) + velocity(1) = 4 -> medium (no tier change)", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "CF -> 2B",
      hasVideo: false,
      isOverturned: false,
      throwVelocity: 96.2,
    });
    expect(tier).toBe("medium");
  });

  test("high velocity promotes borderline: direct to 2B (3) + video(1) + velocity(1) = 5 -> high", () => {
    const tier = calculateTier({
      targetBase: "2B",
      creditChain: "CF -> 2B",
      hasVideo: true,
      isOverturned: false,
      throwVelocity: 97.0,
    });
    expect(tier).toBe("high");
  });

  test("velocity regression: same inputs without velocity yields original tier", () => {
    // This is the FR-1.10 invariant: absent velocity must not change the tier.
    const inputs = {
      targetBase: "Home" as const,
      creditChain: "RF -> C",
      hasVideo: true,
      isOverturned: false,
    };

    const withoutVelocity = calculateTier(inputs);
    const withNullVelocity = calculateTier({ ...inputs, throwVelocity: null });
    const withUndefinedVelocity = calculateTier({ ...inputs, throwVelocity: undefined });

    expect(withoutVelocity).toBe("high");
    expect(withNullVelocity).toBe("high");
    expect(withUndefinedVelocity).toBe("high");
  });
});
