/**
 * Tests for the arm-strength / throw-velocity fetcher.
 *
 * Covers: successful match, no_match (untracked), fetch errors,
 * cache reuse (one fetch for two play lookups).
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import { resolveThrowVelocity, clearThrowCache } from "../arm-velocity";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_THROWS = [
  {
    year: 2025,
    fielder_id: 660271,
    pos: 9,
    pos_role: 9,
    metric: 94.3,
    play_id: "aaa-bbb-ccc",
  },
  {
    year: 2025,
    fielder_id: 660271,
    pos: 9,
    pos_role: 9,
    metric: 88.1,
    play_id: "ddd-eee-fff",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveThrowVelocity", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
    clearThrowCache();
  });

  test("matched: play_id present in throws array returns velocityMph", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(SAMPLE_THROWS), { status: 200 }))
    ) as unknown as typeof fetch;

    const result = await resolveThrowVelocity(660271, 2025, "aaa-bbb-ccc");
    expect(result).toEqual({ status: "matched", velocityMph: 94.3 });
  });

  test("matched: second record in array", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(SAMPLE_THROWS), { status: 200 }))
    ) as unknown as typeof fetch;

    const result = await resolveThrowVelocity(660271, 2025, "ddd-eee-fff");
    expect(result).toEqual({ status: "matched", velocityMph: 88.1 });
  });

  test("no_match: play_id not in throws array returns no_match", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(SAMPLE_THROWS), { status: 200 }))
    ) as unknown as typeof fetch;

    const result = await resolveThrowVelocity(660271, 2025, "nonexistent-id");
    expect(result).toEqual({ status: "no_match" });
  });

  test("no_match: empty throws array returns no_match", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
    ) as unknown as typeof fetch;

    const result = await resolveThrowVelocity(660271, 2025, "aaa-bbb-ccc");
    expect(result).toEqual({ status: "no_match" });
  });

  test("non_200: HTTP 500 returns non_200 variant", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 }))
    ) as unknown as typeof fetch;

    const result = await resolveThrowVelocity(660271, 2025, "aaa-bbb-ccc");
    expect(result).toEqual({ status: "non_200", httpStatus: 500 });
  });

  test("timeout: AbortSignal timeout returns timeout variant", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new DOMException("The operation timed out", "TimeoutError"))
    ) as unknown as typeof fetch;

    const result = await resolveThrowVelocity(660271, 2025, "aaa-bbb-ccc");
    expect(result).toEqual({ status: "timeout" });
  });

  test("network_error: fetch rejection returns network_error variant", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("connection refused"))
    ) as unknown as typeof fetch;

    const result = await resolveThrowVelocity(660271, 2025, "aaa-bbb-ccc");
    expect(result).toEqual({
      status: "network_error",
      error: "connection refused",
    });
  });

  test("network_error: non-array JSON response returns network_error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "bad request" }), { status: 200 })
      )
    ) as unknown as typeof fetch;

    const result = await resolveThrowVelocity(660271, 2025, "aaa-bbb-ccc");
    expect(result).toEqual({
      status: "network_error",
      error: "unexpected response shape (not an array)",
    });
  });

  test("cache reuse: two plays by same fielder/year trigger only one fetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(() => {
      fetchCount++;
      return Promise.resolve(
        new Response(JSON.stringify(SAMPLE_THROWS), { status: 200 })
      );
    }) as unknown as typeof fetch;

    const result1 = await resolveThrowVelocity(660271, 2025, "aaa-bbb-ccc");
    const result2 = await resolveThrowVelocity(660271, 2025, "ddd-eee-fff");

    expect(fetchCount).toBe(1);
    expect(result1).toEqual({ status: "matched", velocityMph: 94.3 });
    expect(result2).toEqual({ status: "matched", velocityMph: 88.1 });
  });

  test("different fielder/year triggers separate fetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(() => {
      fetchCount++;
      return Promise.resolve(
        new Response(JSON.stringify(SAMPLE_THROWS), { status: 200 })
      );
    }) as unknown as typeof fetch;

    await resolveThrowVelocity(660271, 2025, "aaa-bbb-ccc");
    await resolveThrowVelocity(660271, 2026, "aaa-bbb-ccc");

    expect(fetchCount).toBe(2);
  });

  test("filters records to matching fielder_id and year", async () => {
    const mixedThrows = [
      ...SAMPLE_THROWS,
      {
        year: 2025,
        fielder_id: 999999, // different fielder
        pos: 8,
        pos_role: 8,
        metric: 91.0,
        play_id: "other-play-id",
      },
      {
        year: 2024, // different year
        fielder_id: 660271,
        pos: 9,
        pos_role: 9,
        metric: 92.5,
        play_id: "old-play-id",
      },
    ];

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mixedThrows), { status: 200 }))
    ) as unknown as typeof fetch;

    // Should match the 2025/660271 record
    const result1 = await resolveThrowVelocity(660271, 2025, "aaa-bbb-ccc");
    expect(result1).toEqual({ status: "matched", velocityMph: 94.3 });

    // Should not match the other fielder's play
    const result2 = await resolveThrowVelocity(660271, 2025, "other-play-id");
    expect(result2).toEqual({ status: "no_match" });
  });
});
