import { test, expect, describe } from "bun:test";
import { defaultCompletedWeek, explicitWeek } from "../week-window";

/**
 * Builds a Date that, when read in America/Chicago, falls on the given
 * local Y-M-D at the given local hour. Naively constructing
 * `new Date("2026-05-04T12:00:00-05:00")` works for CDT; for CST swap to
 * `-06:00`. Both branches are exercised below.
 */
function chicagoDate(ymd: string, offset: "-05:00" | "-06:00", hour = 12): Date {
  return new Date(`${ymd}T${String(hour).padStart(2, "0")}:00:00${offset}`);
}

describe("defaultCompletedWeek", () => {
  test("Wednesday returns the prior Sunday-Saturday window", () => {
    const wed = chicagoDate("2026-05-06", "-05:00"); // CDT, Wed
    expect(defaultCompletedWeek(wed)).toEqual({
      weekStarting: "2026-04-26",
      weekEnding: "2026-05-02",
    });
  });

  test("Sunday rolls back to the prior complete week (two Sundays back)", () => {
    const sun = chicagoDate("2026-05-03", "-05:00"); // CDT, Sun
    expect(defaultCompletedWeek(sun)).toEqual({
      weekStarting: "2026-04-19",
      weekEnding: "2026-04-25",
    });
  });

  test("Saturday returns the most recent complete week ending today", () => {
    const sat = chicagoDate("2026-05-02", "-05:00"); // CDT, Sat
    expect(defaultCompletedWeek(sat)).toEqual({
      weekStarting: "2026-04-19",
      weekEnding: "2026-04-25",
    });
  });

  test("DST boundary in March doesn't slip a day", () => {
    // 2026 DST starts Sunday March 8 in the US. Pick a Wednesday after.
    const wed = chicagoDate("2026-03-11", "-05:00"); // CDT
    expect(defaultCompletedWeek(wed)).toEqual({
      weekStarting: "2026-03-01",
      weekEnding: "2026-03-07",
    });
  });

  test("standard-time week (CST, January) computes correctly", () => {
    const tue = chicagoDate("2026-01-13", "-06:00"); // CST, Tue
    expect(defaultCompletedWeek(tue)).toEqual({
      weekStarting: "2026-01-04",
      weekEnding: "2026-01-10",
    });
  });
});

describe("explicitWeek", () => {
  test("accepts a Sunday and returns the matching window", () => {
    expect(explicitWeek("2026-04-26")).toEqual({
      weekStarting: "2026-04-26",
      weekEnding: "2026-05-02",
    });
  });

  test("rejects non-Sunday input", () => {
    expect(() => explicitWeek("2026-04-27")).toThrow(/not a Sunday/i);
  });

  test("rejects malformed input", () => {
    expect(() => explicitWeek("04/26/2026")).toThrow(/Invalid/);
    expect(() => explicitWeek("2026-13-05")).toThrow(/Invalid/);
  });
});
