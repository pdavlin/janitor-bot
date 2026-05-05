import { test, expect, describe } from "bun:test";
import { scanContent } from "../check-no-transcript-leakage";

describe("scanContent", () => {
  test("clean file has no findings", () => {
    const src = `
      import type { Transcript } from "./types";
      export function consumePrompt(t: Transcript): string {
        return t.games.map((g) => g.headerTs).join(",");
      }
    `;
    expect(scanContent("clean.ts", src)).toEqual([]);
  });

  test("flags TranscriptMessage near a db.prepare sink", () => {
    const src = `
      import type { TranscriptMessage } from "./types";
      function bad(m: TranscriptMessage): void {
        db.prepare("INSERT INTO logs (text) VALUES ($t)").run({ $t: m.text });
      }
    `;
    const findings = scanContent("bad.ts", src);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.reason).toMatch(/Transcript|sink/i);
  });

  test("flags JSON.stringify in proximity to TranscriptGame", () => {
    const src = `
      import type { TranscriptGame } from "./types";
      function leak(g: TranscriptGame): void {
        logger.info("game", { transcript: JSON.stringify(g) });
      }
    `;
    const findings = scanContent("leak.ts", src);
    expect(findings.length).toBeGreaterThan(0);
  });

  test("allow-marker permits Transcript references when sinks are absent", () => {
    const src = `
      // transcript-leakage-allowed: legitimate prompt builder
      import type { TranscriptMessage } from "./types";
      function render(messages: readonly TranscriptMessage[]): string {
        return messages.map((m) => JSON.stringify({ kind: "msg" })).join("\\n");
      }
    `;
    expect(scanContent("ok.ts", src)).toEqual([]);
  });

  test("allow-marker still rejects strict sinks", () => {
    const src = `
      // transcript-leakage-allowed: prompt builder
      import type { TranscriptMessage } from "./types";
      function render(messages: readonly TranscriptMessage[]): void {
        db.prepare("INSERT INTO logs(t) VALUES (?)").run([messages[0]?.text]);
      }
    `;
    const findings = scanContent("violation.ts", src);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.reason).toMatch(/marked transcript-leakage-allowed/);
  });
});
