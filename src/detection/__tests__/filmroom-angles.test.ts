import { test, expect, describe, mock, beforeEach } from "bun:test";
import { buildAngleUrl, resolveAlternateAngles } from "../filmroom-angles";

// ---------------------------------------------------------------------------
// buildAngleUrl
// ---------------------------------------------------------------------------

describe("buildAngleUrl", () => {
  test("builds home URL", () => {
    expect(buildAngleUrl(776972, "home", "6571e75b-002e-3a60-bf42-82ef0a45ffd1")).toBe(
      "https://fastball-clips.mlb.com/776972/home/6571e75b-002e-3a60-bf42-82ef0a45ffd1.mp4",
    );
  });

  test("builds away URL", () => {
    expect(buildAngleUrl(776972, "away", "6571e75b-002e-3a60-bf42-82ef0a45ffd1")).toBe(
      "https://fastball-clips.mlb.com/776972/away/6571e75b-002e-3a60-bf42-82ef0a45ffd1.mp4",
    );
  });

  test("builds highhome URL", () => {
    expect(buildAngleUrl(776972, "highhome", "6571e75b-002e-3a60-bf42-82ef0a45ffd1")).toBe(
      "https://fastball-clips.mlb.com/776972/highhome/6571e75b-002e-3a60-bf42-82ef0a45ffd1.mp4",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveAlternateAngles — collects ALL available broadcast feeds
// ---------------------------------------------------------------------------

describe("resolveAlternateAngles", () => {
  const originalFetch = globalThis.fetch;
  const testGamePk = 776972;
  const testPlayId = "6571e75b-002e-3a60-bf42-82ef0a45ffd1";

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Map a CDN URL to its feed segment. Check highhome before home since
  // "/highhome/" must not be mistaken for "/home/".
  function feedOf(url: string): "home" | "away" | "highhome" | "?" {
    if (url.includes("/highhome/")) return "highhome";
    if (url.includes("/away/")) return "away";
    if (url.includes("/home/")) return "home";
    return "?";
  }

  test("all feeds 200 → returns [home, away, highhome] with bytes", async () => {
    const sizes: Record<string, number> = { home: 3, away: 2, highhome: 5 };
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const n = sizes[feedOf(String(input))] ?? 1;
      return Promise.resolve(new Response(new Uint8Array(n).buffer, { status: 200 }));
    }) as typeof fetch;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result.map((a) => a.feedType)).toEqual(["home", "away", "highhome"]);
    expect(result.map((a) => a.bytes.byteLength)).toEqual([3, 2, 5]);
  });

  test("only home 200, others 404 → returns [home]", async () => {
    globalThis.fetch = mock((input: RequestInfo | URL) =>
      Promise.resolve(
        feedOf(String(input)) === "home"
          ? new Response(new Uint8Array(1).buffer, { status: 200 })
          : new Response("Not Found", { status: 404 }),
      ),
    ) as typeof fetch;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result.map((a) => a.feedType)).toEqual(["home"]);
  });

  test("home 400, away 200, highhome 404 → returns [away]", async () => {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const feed = feedOf(String(input));
      if (feed === "away") return Promise.resolve(new Response(new Uint8Array(1).buffer, { status: 200 }));
      return Promise.resolve(new Response("nope", { status: feed === "home" ? 400 : 404 }));
    }) as typeof fetch;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result.map((a) => a.feedType)).toEqual(["away"]);
  });

  test("all 404 → returns []", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 }))
    ) as unknown as typeof fetch;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result).toEqual([]);
  });

  test("fetch throws on all → returns [] after trying every feed", async () => {
    const fetchMock = mock(() => Promise.reject(new Error("network down"))) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("timeout on home; away + highhome 200 → returns [away, highhome]", async () => {
    const fetchMock = mock((input: RequestInfo | URL) => {
      if (feedOf(String(input)) === "home") {
        return Promise.reject(new DOMException("The operation timed out", "TimeoutError"));
      }
      return Promise.resolve(new Response(new Uint8Array(1).buffer, { status: 200 }));
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result.map((a) => a.feedType)).toEqual(["away", "highhome"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("sends Referer + correct CDN URLs for every feed", async () => {
    const capturedUrls: string[] = [];
    const capturedHeaders: Headers[] = [];
    const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrls.push(String(input));
      capturedHeaders.push(new Headers(init?.headers));
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await resolveAlternateAngles(testGamePk, testPlayId);

    expect(capturedUrls).toEqual([
      `https://fastball-clips.mlb.com/${testGamePk}/home/${testPlayId}.mp4`,
      `https://fastball-clips.mlb.com/${testGamePk}/away/${testPlayId}.mp4`,
      `https://fastball-clips.mlb.com/${testGamePk}/highhome/${testPlayId}.mp4`,
    ]);
    for (const headers of capturedHeaders) {
      expect(headers.get("Referer")).toBe("https://www.mlb.com/video");
      expect(headers.get("User-Agent")).toContain("Mozilla/5.0");
    }
  });
});
