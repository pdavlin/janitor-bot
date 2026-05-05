/**
 * Keyword-driven tag parsing for Slack thread replies on game-play threads.
 *
 * The parser is a pure function over message text: a flat list of regex
 * patterns paired with `(tag_type, tag_value)` outputs is applied
 * left-to-right with non-overlapping matches. Word boundaries (`\b`) avoid
 * mid-word collisions like "thunderrated" matching "underrated".
 *
 * `attributeToPlay` performs the simple heuristic that disambiguates which
 * play a comment refers to: a single fielder-name substring hit attributes
 * to that play, anything else falls back to the game.
 */

export type TagType = "tier_dispute" | "video_issue";

export interface TagPattern {
  type: TagType;
  value: string;
  pattern: RegExp;
}

export const TAG_PATTERNS: TagPattern[] = [
  { type: "tier_dispute", value: "should_be_high",   pattern: /\bshould be high\b/i },
  { type: "tier_dispute", value: "should_be_low",    pattern: /\bshould be low\b/i },
  { type: "tier_dispute", value: "should_be_medium", pattern: /\bshould be medium\b/i },
  { type: "tier_dispute", value: "overrated",        pattern: /\boverrated\b/i },
  { type: "tier_dispute", value: "underrated",       pattern: /\bunderrated\b/i },

  { type: "video_issue",  value: "wrong_video",      pattern: /\bwrong video\b/i },
  { type: "video_issue",  value: "video_missing",    pattern: /\b(video missing|no video)\b/i },
  { type: "video_issue",  value: "broken_link",      pattern: /\b(broken link|broken video)\b/i },
];

export interface ParsedTag {
  type: TagType;
  value: string;
  matchedText: string;
  matchStart: number;
}

/**
 * Returns every tag matched by `TAG_PATTERNS`, with overlapping matches
 * resolved greedily from left to right. The same input text yields the same
 * tags (deterministic) regardless of pattern array ordering, except where
 * two patterns overlap on identical character ranges — in that case the
 * earlier-listed pattern wins because of the stable sort by `matchStart`.
 */
export function parseTags(text: string): ParsedTag[] {
  if (!text) return [];

  const candidates: ParsedTag[] = [];
  for (const p of TAG_PATTERNS) {
    const re = new RegExp(p.pattern.source, p.pattern.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      candidates.push({
        type: p.type,
        value: p.value,
        matchedText: m[0],
        matchStart: m.index,
      });
    }
  }

  candidates.sort((a, b) => a.matchStart - b.matchStart);
  const accepted: ParsedTag[] = [];
  let cursor = -1;
  for (const c of candidates) {
    if (c.matchStart >= cursor) {
      accepted.push(c);
      cursor = c.matchStart + c.matchedText.length;
    }
  }
  return accepted;
}

/**
 * Attributes a comment to a specific play if the comment text mentions exactly
 * one fielder by name (case-insensitive substring match). Substring (not
 * whole word) is intentional — possessives like "Soto's throw" should still
 * match "Soto". Multi-fielder mentions and zero-fielder mentions both return
 * `null`, signalling game-level attribution.
 */
export function attributeToPlay(
  text: string,
  fielderNames: { fielderName: string; playIndex: number }[],
): number | null {
  const lower = text.toLowerCase();
  const hits = fielderNames.filter((f) =>
    lower.includes(f.fielderName.toLowerCase()),
  );
  if (hits.length === 1) return hits[0].playIndex;
  return null;
}
