import { test, expect, describe, mock, beforeEach } from "bun:test";
import { extractPlayId, fetchSavantVideo } from "../savant-video";
import type { PlayEvent } from "../../types/mlb-api";

// ---------------------------------------------------------------------------
// extractPlayId
// ---------------------------------------------------------------------------

describe("extractPlayId", () => {
  test("returns null for undefined input", () => {
    expect(extractPlayId(undefined)).toBeNull();
  });

  test("returns null for empty array", () => {
    expect(extractPlayId([])).toBeNull();
  });

  test("returns null when no pitch events exist", () => {
    const events: PlayEvent[] = [
      { isPitch: false },
      { isPitch: false, playId: "abc-123" },
    ];
    expect(extractPlayId(events)).toBeNull();
  });

  test("returns null when pitch events have no playId", () => {
    const events: PlayEvent[] = [{ isPitch: true }];
    expect(extractPlayId(events)).toBeNull();
  });

  test("returns the last pitch event playId", () => {
    const events: PlayEvent[] = [
      { isPitch: true, playId: "first-pitch-id" },
      { isPitch: false },
      { isPitch: true, playId: "second-pitch-id" },
      { isPitch: true, playId: "last-pitch-id" },
      { isPitch: false },
    ];
    expect(extractPlayId(events)).toBe("last-pitch-id");
  });

  test("returns the only pitch event playId", () => {
    const events: PlayEvent[] = [
      { isPitch: false },
      { isPitch: true, playId: "6571e75b-002e-3a60-bf42-82ef0a45ffd1" },
    ];
    expect(extractPlayId(events)).toBe(
      "6571e75b-002e-3a60-bf42-82ef0a45ffd1"
    );
  });
});

// ---------------------------------------------------------------------------
// fetchSavantVideo
// ---------------------------------------------------------------------------

describe("fetchSavantVideo", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns video URL from valid Savant response", async () => {
    const html = `
      <html><body>
        <video>
          <source src="https://sporty-clips.mlb.com/abc123.mp4" type="video/mp4">
        </video>
      </body></html>
    `;

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toEqual({
      videoUrl: "https://sporty-clips.mlb.com/abc123.mp4",
      videoTitle: "Baseball Savant Video",
    });
  });

  test("decodes HTML entities in video URL", async () => {
    const html = `
      <html><body>
        <video>
          <source src="https://sporty-clips.mlb.com/clip.mp4?token&#x3D;abc&amp;expires&#x3D;123" type="video/mp4">
        </video>
      </body></html>
    `;

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toEqual({
      videoUrl:
        "https://sporty-clips.mlb.com/clip.mp4?token=abc&expires=123",
      videoTitle: "Baseball Savant Video",
    });
  });

  test("returns null when Savant says No Video Found", async () => {
    const html = `<html><body><h1>No Video Found</h1></body></html>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toBeNull();
  });

  test("returns null on non-200 response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Forbidden", { status: 403 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toBeNull();
  });

  test("returns null on network error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network failure"))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toBeNull();
  });

  test("returns null when HTML has no source tag", async () => {
    const html = `<html><body><video></video></body></html>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toBeNull();
  });

  test("sends correct URL and User-Agent header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return Promise.resolve(
        new Response("<h1>No Video Found</h1>", { status: 200 })
      );
    }) as typeof fetch;

    await fetchSavantVideo("6571e75b-002e-3a60-bf42-82ef0a45ffd1");

    expect(capturedUrl).toBe(
      "https://baseballsavant.mlb.com/sporty-videos?playId=6571e75b-002e-3a60-bf42-82ef0a45ffd1"
    );
    expect(capturedHeaders?.get("User-Agent")).toContain("Mozilla/5.0");
  });

  test("decodes decimal HTML entities", async () => {
    const html = `
      <video>
        <source src="https://sporty-clips.mlb.com/clip.mp4?a&#38;b" type="video/mp4">
      </video>
    `;

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result?.videoUrl).toBe(
      "https://sporty-clips.mlb.com/clip.mp4?a&b"
    );
  });
});
