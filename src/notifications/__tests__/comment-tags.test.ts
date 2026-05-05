/**
 * Tests for the comment-tag parser and play-attribution heuristic.
 *
 * Pure unit tests — no database, no fixtures beyond plain strings.
 */

import { test, expect, describe } from "bun:test";
import { parseTags, attributeToPlay } from "../comment-tags";

describe("parseTags", () => {
  test("returns no tags for empty text", () => {
    expect(parseTags("")).toEqual([]);
  });

  test("returns no tags when nothing matches", () => {
    expect(parseTags("nice play")).toEqual([]);
  });

  test("matches a single tier_dispute keyword", () => {
    const tags = parseTags("yeah it should be high");
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({
      type: "tier_dispute",
      value: "should_be_high",
      matchedText: "should be high",
    });
  });

  test("matches should_be_low and should_be_medium", () => {
    expect(parseTags("this should be low").map((t) => t.value)).toEqual([
      "should_be_low",
    ]);
    expect(parseTags("should be medium maybe").map((t) => t.value)).toEqual([
      "should_be_medium",
    ]);
  });

  test("matches video_issue keywords", () => {
    expect(parseTags("wrong video here").map((t) => t.value)).toEqual([
      "wrong_video",
    ]);
    expect(parseTags("no video on this one").map((t) => t.value)).toEqual([
      "video_missing",
    ]);
    expect(parseTags("video missing again").map((t) => t.value)).toEqual([
      "video_missing",
    ]);
    expect(parseTags("broken link sorry").map((t) => t.value)).toEqual([
      "broken_link",
    ]);
    expect(parseTags("broken video link").map((t) => t.value)).toEqual([
      "broken_link",
    ]);
  });

  test("multiple keywords in one comment produce multiple tags", () => {
    const tags = parseTags("wrong video and overrated");
    expect(tags).toHaveLength(2);
    expect(tags.map((t) => t.value).sort()).toEqual(
      ["overrated", "wrong_video"].sort(),
    );
  });

  test("matching is case-insensitive", () => {
    const tags = parseTags("Wrong Video");
    expect(tags).toHaveLength(1);
    expect(tags[0].value).toBe("wrong_video");
  });

  test("word boundary prevents matching inside other words", () => {
    expect(parseTags("thunderrated")).toEqual([]);
    expect(parseTags("overrated!")).toHaveLength(1);
  });

  test("greedy non-overlapping resolves overlaps", () => {
    const tags = parseTags("should be high and overrated");
    expect(tags).toHaveLength(2);
    expect(tags[0].matchStart).toBeLessThan(tags[1].matchStart);
  });

  test("repeats of the same keyword yield repeated tags", () => {
    const tags = parseTags("overrated overrated");
    expect(tags).toHaveLength(2);
    expect(tags.every((t) => t.value === "overrated")).toBe(true);
  });
});

describe("attributeToPlay", () => {
  const fielders = [
    { fielderName: "Juan Soto", playIndex: 5 },
    { fielderName: "Mookie Betts", playIndex: 7 },
    { fielderName: "Cody Bellinger", playIndex: 9 },
  ];

  test("attributes to the single play whose fielder is mentioned", () => {
    expect(attributeToPlay("Juan Soto's throw was wrong video", fielders)).toBe(5);
  });

  test("returns null when no fielder is mentioned", () => {
    expect(attributeToPlay("Wrong video on the broadcast", fielders)).toBeNull();
  });

  test("returns null when multiple fielders are mentioned", () => {
    expect(
      attributeToPlay("Juan Soto and Mookie Betts both should be high", fielders),
    ).toBeNull();
  });

  test("matches case-insensitively", () => {
    expect(attributeToPlay("CODY BELLINGER killed it", fielders)).toBe(9);
  });

  test("substring-match handles possessives", () => {
    expect(attributeToPlay("Cody Bellinger's throw, wrong video", fielders)).toBe(9);
  });

  test("returns null when the fielder list is empty", () => {
    expect(attributeToPlay("Juan Soto's throw", [])).toBeNull();
  });
});
