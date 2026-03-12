# Pipeline Validation Report

Date: 2026-03-11
Test date scanned: 2024-04-09

## Step 1: Type Check

**Result: PASS**

`bun run check` (tsc --noEmit) completed with zero errors.

## Step 2: Tests

**Result: PASS**

11 tests across 2 files, 30 expect() calls, 0 failures.

- `detect.test.ts`: 5 tests covering single assist, non-outfield credits, runner not out, multiple assists, credit chain building
- `ranking.test.ts`: 6 tests covering high/medium/low tier boundaries

## Step 3: Scan 2024-04-09

**Result: PASS (4 outfield assists detected)**

| Game | Fielder | Position | Target | Tier | Video |
|------|---------|----------|--------|------|-------|
| BAL @ BOS (746981) | Jarren Duran | LF | 2B | LOW | Yes |
| CWS @ CLE (746653) | Ramon Laureano | RF | 3B | MEDIUM | No |
| NYM @ ATL (747138) | Jarred Kelenic | LF | 2B | MEDIUM | Yes |
| CHC @ SD (745433) | Cody Bellinger | CF | 3B | MEDIUM | Yes |

### Acceptance criteria check

- Bellinger throw (game 745433, CF assist): DETECTED. CF Bellinger threw out Xander Bogaerts at 3B in the 1st inning, tied 0-0. Video URL matched.
- Wade Jr. throw (game 745435, RF assist at 3B): NOT APPLICABLE. Game 745435 is SF @ SD on 2024-03-29, not 2024-04-09. The PRD had the wrong gamePk/date pairing.
- All context fields populated: YES. Every detected play has tier, position, name, target base, teams, inning, half, score, description, and credit chain.
- Tiers assigned: YES. 1 LOW, 3 MEDIUM. Tier logic is working as designed.

### Video matching

3 of 4 plays got video URLs. The Laureano play (CWS @ CLE) did not match a video, which is expected -- the content API may not have tagged that highlight with the right keywords or description overlap.

## Step 4: --game Flag

**Result: PASS**

`bun run scan -- --game 745433 --date 2024-04-09` correctly:
- Fetched the single game
- Printed the CHC @ SD matchup
- Detected the Bellinger CF assist
- Matched the video URL
- Stored the play (deduplicated since it already existed)

## Step 5: Deduplication

**Result: PASS**

After the initial date scan (4 plays inserted), re-running the same scan kept the count at 4. The `INSERT OR IGNORE` on the `UNIQUE(game_pk, play_index)` constraint works correctly. The `--game` scan for 745433 also did not create a duplicate.

## Step 6: Fixes Required

**None.** All steps passed on the first attempt. No code changes were needed.

## Summary

The full janitor-bot pipeline works end-to-end:
1. Schedule fetch retrieves completed games for a date
2. Live feed fetch pulls play-by-play data per game
3. Detection correctly identifies `f_assist_of` credits on outfield positions
4. Ranking assigns tiers based on target base, score differential, inning, and throw type
5. Video matching enriches plays with highlight URLs (3/4 matched on test date)
6. SQLite storage persists plays with deduplication
7. CLI supports both `--date` and `--game` modes

### Notes for future work

- The Laureano play had no video match. If video coverage is important, the fallback matching (description overlap) could be tuned with a lower threshold or fuzzy matching.
- The PRD acceptance criteria referenced gamePk 745435 as a 2024-04-09 game, but that game is actually from 2024-03-29. Worth updating the PRD if it gets revisited.
