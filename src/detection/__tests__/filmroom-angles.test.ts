import { test, expect, describe, mock, beforeEach } from "bun:test";
import { buildAngleUrl, resolveAlternateAngle } from "../filmroom-angles";

// ---------------------------------------------------------------------------
// buildAngleUrl
// ---------------------------------------------------------------------------

describe("buildAngleUrl", () => {
  test("builds cf URL", () => {
    expect(buildAngleUrl(776972, "cf", "6571e75b-002e-3a60-bf42-82ef0a45ffd1")).toBe(
      "https://fastball-clips.mlb.com/776972/cf/6571e75b-002e-3a60-bf42-82ef0a45ffd1.mp4",
    );
  });

  test("builds highhome URL", () => {
    expect(buildAngleUrl(776972, "highhome", "6571e75b-002e-3a60-bf42-82ef0a45ffd1")).toBe(
      "https://fastball-clips.mlb.com/776972/highhome/6571e75b-002e-3a60-bf42-82ef0a45ffd1.mp4",
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

  test("cf 200 → found with cf bytes", async () => {
    const fakeBytes = new Uint8Array([0x00, 0x01, 0x02]).buffer;

    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/cf/");
      expect(new Headers(init?.headers).get("Referer")).toBe("https://www.mlb.com/video");
      return Promise.resolve(
        new Response(fakeBytes, { status: 200, headers: { "Content-Type": "video/mp4" } }),
      );
    }) as typeof fetch;

    const result = await resolveAlternateAngle(testGamePk, testPlayId);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.feedType).toBe("cf");
      expect(result.url).toContain("/cf/");
      expect(result.bytes.byteLength).toBe(3);
    }
  });

  test("cf 400 then highhome 200 → found highhome", async () => {
    const fakeBytes = new Uint8Array([0x00, 0x01]).buffer;
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cf/")) {
        return Promise.resolve(new Response("Not Found", { status: 400 }));
      }
      if (url.includes("/highhome/")) {
        return Promise.resolve(new Response(fakeBytes, { status: 200 }));
      }
      return Promise.resolve(new Response("Unexpected", { status: 404 }));
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngle(testGamePk, testPlayId);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.feedType).toBe("highhome");
      expect(result.url).toContain("/highhome/");
    }
    // fetch called twice: once for cf, once for highhome
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("both cf and highhome 404 → no_alternate", async () => {
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
      if (url.includes("/cf/")) {
        return Promise.reject(new DOMException("The operation timed out", "TimeoutError"));
      }
      return Promise.resolve(new Response(fakeBytes, { status: 200 }));
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngle(testGamePk, testPlayId);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.feedType).toBe("highhome");
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

    // First call should be cf
    expect(capturedUrls[0]).toBe(
      `https://fastball-clips.mlb.com/${testGamePk}/cf/${testPlayId}.mp4`,
    );
    // Second call should be highhome
    expect(capturedUrls[1]).toBe(
      `https://fastball-clips.mlb.com/${testGamePk}/highhome/${testPlayId}.mp4`,
    );
  });

  test("unexpected 500 → tries next feed type", async () => {
    const fakeBytes = new Uint8Array([0x00]).buffer;
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cf/")) {
        return Promise.resolve(new Response("Server Error", { status: 500 }));
      }
      return Promise.resolve(new Response(fakeBytes, { status: 200 }));
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await resolveAlternateAngle(testGamePk, testPlayId);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.feedType).toBe("highhome");
    }
  });
});
