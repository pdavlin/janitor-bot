#!/usr/bin/env bun
/**
 * CI guard against transcript content leaking into DB writes or logs.
 *
 * The branded `Transcript` type catches direct passes at compile time,
 * but `JSON.stringify(someObject)` where the object happens to carry
 * transcript fields would type-check and bypass the brand. This grep
 * is the defense-in-depth backup: simple regex with multi-line
 * tolerance; false positives are acceptable (rename the field to clear
 * the matcher), false negatives are not — privacy intent requires
 * erring toward false-positive over false-negative.
 *
 * Exit 0 on a clean scan; exit 1 with offending file:line on any match.
 */

import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SCAN_DIR = path.join(ROOT, "src/cli/weekly-review");

interface Finding {
  file: string;
  line: number;
  reason: string;
  excerpt: string;
}

const SINK_PATTERN =
  /db\.prepare|db\.run|logger\.(?:info|warn|error)|chat\.(?:postMessage|update)|JSON\.stringify/;

const TRANSCRIPT_NEAR_SINK_FORWARD = new RegExp(
  String.raw`(TranscriptMessage|TranscriptGame)[\s\S]{0,500}(${SINK_PATTERN.source})`,
);
const TRANSCRIPT_NEAR_SINK_REVERSE = new RegExp(
  String.raw`(${SINK_PATTERN.source})[\s\S]{0,500}(TranscriptMessage|TranscriptGame)`,
);
const TRANSCRIPT_FIELD_IN_RUN = new RegExp(
  String.raw`db\.prepare\([\s\S]+?\.run\(\s*\{[\s\S]+?\btranscript\b[\s\S]+?\}`,
  "i",
);

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of new Bun.Glob("**/*.ts").scan({ cwd: dir, absolute: true })) {
    if (entry.includes("/__tests__/")) continue;
    yield entry;
  }
}

function lineNumberOf(content: string, match: RegExpExecArray): number {
  return content.substring(0, match.index).split("\n").length;
}

function excerptAround(content: string, match: RegExpExecArray): string {
  const before = content.lastIndexOf("\n", match.index) + 1;
  const after = content.indexOf("\n", match.index + match[0].length);
  return content.substring(before, after === -1 ? undefined : after).trim();
}

/**
 * Honored opt-out marker for files that legitimately reference both
 * `TranscriptMessage` and a sink-like token but never persist or log.
 * `prompt.ts` is the canonical case: it consumes the transcript to
 * build the LLM prompt body, and uses `JSON.stringify` only for
 * non-transcript sections.
 *
 * Required body of the comment is `// transcript-leakage-allowed: <reason>`
 * — the reason field is mandatory so reviewers can audit each use.
 */
const ALLOW_MARKER = /\/\/\s*transcript-leakage-allowed:\s*\S+/;

async function scanFile(file: string, findings: Finding[]): Promise<void> {
  const content = await Bun.file(file).text();
  if (ALLOW_MARKER.test(content)) {
    // Still enforce the strict "no DB/log/Slack sinks at all" rule for
    // opted-out files so they can't drift later.
    const STRICT_SINK = /db\.(prepare|run)|logger\.(info|warn|error)|chat\.(postMessage|update)/;
    const strict = STRICT_SINK.exec(content);
    if (strict) {
      findings.push({
        file,
        line: lineNumberOf(content, strict),
        reason:
          "file is marked transcript-leakage-allowed but uses a real persistence/logging sink",
        excerpt: excerptAround(content, strict),
      });
    }
    return;
  }

  const fwd = TRANSCRIPT_NEAR_SINK_FORWARD.exec(content);
  if (fwd) {
    findings.push({
      file,
      line: lineNumberOf(content, fwd),
      reason: "Transcript type colocated with persistence/logging sink",
      excerpt: excerptAround(content, fwd),
    });
  }

  const rev = TRANSCRIPT_NEAR_SINK_REVERSE.exec(content);
  if (rev) {
    findings.push({
      file,
      line: lineNumberOf(content, rev),
      reason: "persistence/logging sink colocated with Transcript type",
      excerpt: excerptAround(content, rev),
    });
  }

  const field = TRANSCRIPT_FIELD_IN_RUN.exec(content);
  if (field) {
    findings.push({
      file,
      line: lineNumberOf(content, field),
      reason: "transcript field used inside db.prepare(...).run({...})",
      excerpt: excerptAround(content, field),
    });
  }
}

async function main(): Promise<void> {
  const findings: Finding[] = [];
  for await (const file of walk(SCAN_DIR)) {
    await scanFile(file, findings);
  }

  if (findings.length === 0) {
    process.stdout.write("check-no-transcript-leakage: clean\n");
    return;
  }

  process.stderr.write(
    `check-no-transcript-leakage: ${findings.length} potential leak(s) found\n`,
  );
  for (const f of findings) {
    const rel = path.relative(ROOT, f.file);
    process.stderr.write(`  ${rel}:${f.line} — ${f.reason}\n`);
    process.stderr.write(`    > ${f.excerpt}\n`);
  }
  process.exit(1);
}

/**
 * In-memory scan helper for unit tests. Mirrors the file-walking path
 * but accepts a `(filename, content)` map so a synthetic leak can be
 * fed in without touching the real filesystem.
 */
export function scanContent(file: string, content: string): Finding[] {
  const findings: Finding[] = [];
  if (ALLOW_MARKER.test(content)) {
    const STRICT_SINK = /db\.(prepare|run)|logger\.(info|warn|error)|chat\.(postMessage|update)/;
    const strict = STRICT_SINK.exec(content);
    if (strict) {
      findings.push({
        file,
        line: lineNumberOf(content, strict),
        reason:
          "file is marked transcript-leakage-allowed but uses a real persistence/logging sink",
        excerpt: excerptAround(content, strict),
      });
    }
    return findings;
  }
  const fwd = TRANSCRIPT_NEAR_SINK_FORWARD.exec(content);
  if (fwd) {
    findings.push({
      file,
      line: lineNumberOf(content, fwd),
      reason: "Transcript type colocated with persistence/logging sink",
      excerpt: excerptAround(content, fwd),
    });
  }
  const rev = TRANSCRIPT_NEAR_SINK_REVERSE.exec(content);
  if (rev) {
    findings.push({
      file,
      line: lineNumberOf(content, rev),
      reason: "persistence/logging sink colocated with Transcript type",
      excerpt: excerptAround(content, rev),
    });
  }
  const field = TRANSCRIPT_FIELD_IN_RUN.exec(content);
  if (field) {
    findings.push({
      file,
      line: lineNumberOf(content, field),
      reason: "transcript field used inside db.prepare(...).run({...})",
      excerpt: excerptAround(content, field),
    });
  }
  return findings;
}

if (import.meta.main) {
  await main();
}
