# CLI Entry Point - Implementation Notes

## File
`src/cli/scan.ts`

## What it does
The CLI entry point ties together all janitor-bot modules into a single scanning pipeline. It parses command-line arguments, fetches MLB data, detects outfield assists, matches highlight videos, stores results in SQLite, and prints formatted output.

## How to run
```bash
bun run scan                        # scan yesterday's games
bun run scan -- --date 2025-06-15   # scan a specific date
bun run scan -- --game 745433       # scan a single game by gamePk
bun run scan -- --game 745433 --date 2025-06-15  # single game with explicit date
```

## Architecture

### Two execution paths

1. **Date scan** (default path): fetches the MLB schedule for a date, filters to completed games, then runs detection on each.
2. **Single game scan** (`--game` flag): fetches the live feed directly for one gamePk. If `--date` is also provided, uses that as the game date. Otherwise falls back to today's date.

### Pipeline per game
1. `fetchLiveFeed(gamePk)` - get play-by-play data
2. `detectOutfieldAssists(liveFeed, gamePk, date)` - find outfield assists
3. `fetchGameContent(gamePk)` + `matchVideoToPlay()` - match highlight videos (best-effort, errors are warned and swallowed)
4. `insertPlays(db, plays)` - store in SQLite with dedup via UNIQUE constraint
5. `printPlay()` - console output

### Error handling
- API errors (MlbApiError) are caught at the top level with a descriptive message.
- Per-game errors in the date scan path are caught individually so one failing game does not abort the whole scan.
- Video content fetch failures are warned but do not discard detected plays.

## Key design decisions

### No external arg parser
Simple `--flag value` parsing via a for-loop over `Bun.argv.slice(2)`. The two flags (`--date`, `--game`) do not justify a dependency.

### Game date for --game mode
Our typed subset of the live feed response does not include `gameData.datetime.dateTime`. When `--game` is used without `--date`, the scanner falls back to today's date. This is a known limitation. If precise date tracking matters, pass `--date` alongside `--game`.

### processGame is not called from scanSingleGame
`scanSingleGame` fetches the live feed itself to log the matchup before running detection. This avoids a double fetch while keeping the logging behavior. `processGame` exists for the date-scan path where the matchup info comes from the schedule.

## Environment variables
- `DB_PATH` - SQLite database file path (default: `./janitor-throws.db`)

## Dependencies (all internal)
- `src/api/mlb-client.ts` - API fetch functions
- `src/detection/detect.ts` - outfield assist detection
- `src/detection/video-match.ts` - highlight video matching
- `src/storage/db.ts` - SQLite persistence
