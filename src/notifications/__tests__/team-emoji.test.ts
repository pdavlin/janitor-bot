/**
 * Tests for the static MLB-team-abbreviation -> Slack-emoji-slug map.
 *
 * The repo's `mlb_teams_emoji/` folder is the source of truth for which
 * custom emoji exist in the Slack workspace. These tests assert two things:
 *
 *   1. Every mapped slug points at a real PNG in `mlb_teams_emoji/` —
 *      catches typos / stale slugs.
 *   2. Every PNG in the folder is reachable from at least one abbreviation —
 *      catches uploaded emoji that the formatter would never use.
 */

import { test, expect, describe } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { TEAM_ABBREV_TO_EMOJI, teamEmoji } from "../team-emoji";

const EMOJI_DIR = join(import.meta.dir, "..", "..", "..", "mlb_teams_emoji");

function listEmojiSlugs(): string[] {
  return readdirSync(EMOJI_DIR)
    .filter((f) => f.endsWith(".png"))
    .map((f) => f.replace(/\.png$/, ""));
}

describe("teamEmoji lookup", () => {
  test("returns slug for known abbreviation", () => {
    expect(teamEmoji("NYY")).toBe("new-york-yankees");
  });

  test("returns null for unknown abbreviation", () => {
    expect(teamEmoji("ZZZ")).toBeNull();
  });

  test("OAK and ATH both resolve to the athletics emoji", () => {
    expect(teamEmoji("OAK")).toBe("athletics");
    expect(teamEmoji("ATH")).toBe("athletics");
  });

  test("CHW and CWS both resolve to the white sox emoji", () => {
    expect(teamEmoji("CHW")).toBe("chicago-white-sox");
    expect(teamEmoji("CWS")).toBe("chicago-white-sox");
  });
});

describe("emoji directory ↔ map coverage", () => {
  const slugsOnDisk = listEmojiSlugs();
  const slugsInMap = new Set(Object.values(TEAM_ABBREV_TO_EMOJI));

  test("every map value matches a file in mlb_teams_emoji/", () => {
    const onDisk = new Set(slugsOnDisk);
    const missing = [...slugsInMap].filter((slug) => !onDisk.has(slug));
    expect(missing).toEqual([]);
  });

  test("every emoji file is reachable from at least one abbreviation", () => {
    const orphans = slugsOnDisk.filter((slug) => !slugsInMap.has(slug));
    expect(orphans).toEqual([]);
  });
});
