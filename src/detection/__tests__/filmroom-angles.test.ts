import { test, expect, describe, mock, beforeEach } from "bun:test";
import { buildAngleUrl, resolveAlternateAngle } from "../filmroom-angles";

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
// resolveAlternateAngle
// ---------------------------------------------------------------------------

describe("resolveAlternateAngle", () => {
  const originalFetch = globalThis.fetch;
  const testGamePk = 776972;
  const testPlayId = "6571e75b-002e-3a60-bf42-82ef0a45ffd1";

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("home 200 → found with home bytes", async () => {
    const fakeBytes = new Uint8Array([0x00, 0x01, 0x02]).buffer;

    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/home/");
      expect(new Headers(init?.headers).get("Referer")).toBe("https://www.mlb.com/video");
      return Promise.resolve(
        new Response(fakeBytes, { status: 200, headers: { "Content-Type": "video/mp4" } }),
      );
    }) as typeof fetch;

    const result = await resolveAlternateAngle(testGamePk, testPlayId);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.feedType).toBe("home");
      expect(result.url).toContain("/home/");
      expect(result.bytes.byteLength).toBe(3);
    }
  });

  test("home 400 then away 200 → found away", async () => {
    const fakeBytes = new Uint8Array([0x00, 0x01]).buffer;
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/home/")) {
        return Promise.resolve(new Response("Not Found", { status: 400 }));
      }
      if (url.includes("/away/")) {
        return Promise.resolve(new Response(fakeBytes, { status: 200 }));
      }
      return Promise.resolve(new Response("Unexpected", { status: 404 }));
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngle(testGamePk, testPlayId);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.feedType).toBe("away");
      expect(result.url).toContain("/away/");
    }
    // fetch called twice: once for home, once for away
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("both home and away 404 → no_alternate", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 }))
    ) as unknown as typeof fetch;

    const result = await resolveAlternateAngle(testGamePk, testPlayId);
    expect(result).toEqual({ status: "no_alternate" });
  });

  test("fetch throws → returns after trying both feed types", async () => {
    const fetchMock = mock(() => Promise.reject(new Error("network down"))) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngle(testGamePk, testPlayId);
    expect(result).toEqual({ status: "no_alternate" });
    // Tried both feed types
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("timeout on first feed type → tries second", async () => {
    const fakeBytes = new Uint8Array([0x00]).buffer;
    let callCount = 0;
    const fetchMock = mock((input: RequestInfo | URL) => {
      callCount++;
      const url = String(input);
      if (url.includes("/home/")) {
        return Promise.reject(new DOMException("The operation timed out", "TimeoutError"));
      }
      return Promise.resolve(new Response(fakeBytes, { status: 200 }));
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngle(testGamePk, testPlayId);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.feedType).toBe("away");
    }
    expect(callCount).toBe(2);
  });

  test("sends Referer header on all requests", async () => {
    const capturedHeaders: Headers[] = [];
    const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders.push(new Headers(init?.headers));
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    await resolveAlternateAngle(testGamePk, testPlayId);

    expect(capturedHeaders.length).toBe(2);
    for (const headers of capturedHeaders) {
      expect(headers.get("Referer")).toBe("https://www.mlb.com/video");
      expect(headers.get("User-Agent")).toContain("Mozilla/5.0");
    }
  });

  test("sends correct CDN URL structure", async () => {
    const capturedUrls: string[] = [];
    const fetchMock = mock((input: RequestInfo | URL) => {
      capturedUrls.push(String(input));
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await resolveAlternateAngle(testGamePk, testPlayId);

    // First call should be home
    expect(capturedUrls[0]).toBe(
      `https://fastball-clips.mlb.com/${testGamePk}/home/${testPlayId}.mp4`,
    );
    // Second call should be away
    expect(capturedUrls[1]).toBe(
      `https://fastball-clips.mlb.com/${testGamePk}/away/${testPlayId}.mp4`,
    );
  });

  test("unexpected 500 → tries next feed type", async () => {
    const fakeBytes = new Uint8Array([0x00]).buffer;
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/home/")) {
        return Promise.resolve(new Response("Server Error", { status: 500 }));
      }
      return Promise.resolve(new Response(fakeBytes, { status: 200 }));
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngle(testGamePk, testPlayId);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.feedType).toBe("away");
    }
  });
});
