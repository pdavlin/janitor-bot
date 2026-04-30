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

  test("success: HTML with valid <source> returns success variant", async () => {
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
      status: "success",
      videoUrl: "https://sporty-clips.mlb.com/abc123.mp4",
      videoTitle: "Baseball Savant Video",
    });
  });

  test("success: decodes HTML entities in video URL", async () => {
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
      status: "success",
      videoUrl:
        "https://sporty-clips.mlb.com/clip.mp4?token=abc&expires=123",
      videoTitle: "Baseball Savant Video",
    });
  });

  test("success: decodes decimal HTML entities", async () => {
    const html = `
      <video>
        <source src="https://sporty-clips.mlb.com/clip.mp4?a&#38;b" type="video/mp4">
      </video>
    `;

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.videoUrl).toBe("https://sporty-clips.mlb.com/clip.mp4?a&b");
    }
  });

  test("no_video_found: HTML containing 'No Video Found' returns variant", async () => {
    const html = `<html><body><h1>No Video Found</h1></body></html>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toEqual({ status: "no_video_found" });
  });

  test("no_source_tag: HTML 200 with no <source> returns variant", async () => {
    const html = `<html><body><video></video></body></html>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toEqual({ status: "no_source_tag" });
  });

  test("non_200: 500 response returns variant with httpStatus", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toEqual({ status: "non_200", httpStatus: 500 });
  });

  test("non_200: 403 response returns variant with httpStatus", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Forbidden", { status: 403 }))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toEqual({ status: "non_200", httpStatus: 403 });
  });

  test("timeout: AbortSignal timeout DOMException returns timeout variant", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new DOMException("The operation timed out", "TimeoutError"))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toEqual({ status: "timeout" });
  });

  test("network_error: fetch rejection returns variant with error message", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network failure"))
    ) as typeof fetch;

    const result = await fetchSavantVideo("test-play-id");
    expect(result).toEqual({
      status: "network_error",
      error: "network failure",
    });
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
});
