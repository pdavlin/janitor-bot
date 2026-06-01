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

  test("both feeds 200 → returns [home, away] with bytes", async () => {
    const home = new Uint8Array([0x00, 0x01, 0x02]).buffer;
    const away = new Uint8Array([0x03, 0x04]).buffer;
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/home/") ? home : away;
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result.map((a) => a.feedType)).toEqual(["home", "away"]);
    expect(result[0]!.bytes.byteLength).toBe(3);
    expect(result[1]!.bytes.byteLength).toBe(2);
    expect(result[0]!.url).toContain("/home/");
    expect(result[1]!.url).toContain("/away/");
  });

  test("home 200, away 404 → returns [home] only", async () => {
    const home = new Uint8Array([0x00]).buffer;
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(
        url.includes("/home/")
          ? new Response(home, { status: 200 })
          : new Response("Not Found", { status: 404 }),
      );
    }) as typeof fetch;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result.map((a) => a.feedType)).toEqual(["home"]);
  });

  test("home 400, away 200 → returns [away] only", async () => {
    const away = new Uint8Array([0x00]).buffer;
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(
        url.includes("/home/")
          ? new Response("Bad Request", { status: 400 })
          : new Response(away, { status: 200 }),
      );
    }) as typeof fetch;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result.map((a) => a.feedType)).toEqual(["away"]);
  });

  test("both 404 → returns []", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 }))
    ) as unknown as typeof fetch;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result).toEqual([]);
  });

  test("fetch throws on both → returns [] after trying both", async () => {
    const fetchMock = mock(() => Promise.reject(new Error("network down"))) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("timeout on home, away 200 → returns [away]", async () => {
    const away = new Uint8Array([0x00]).buffer;
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/home/")) {
        return Promise.reject(new DOMException("The operation timed out", "TimeoutError"));
      }
      return Promise.resolve(new Response(away, { status: 200 }));
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngles(testGamePk, testPlayId);
    expect(result.map((a) => a.feedType)).toEqual(["away"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("sends Referer + correct CDN URLs on both requests", async () => {
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
    ]);
    for (const headers of capturedHeaders) {
      expect(headers.get("Referer")).toBe("https://www.mlb.com/video");
      expect(headers.get("User-Agent")).toContain("Mozilla/5.0");
    }
  });
});
