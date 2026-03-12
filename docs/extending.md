# Extending and Contributing

A practical guide for modifying janitor-bot. For the technical internals, see [Architecture](./architecture.md). For the MLB data model, see [MLB API Guide](./mlb-api-guide.md).

## How to Add New Ranking Signals

The ranking system lives in `src/detection/ranking.ts`. Follow these steps:

1. Add your new field to the `TierInput` interface. This defines what data the ranking function can see.
2. Update `calculateTier` to use the new field in its scoring logic. Keep the point values and tier boundaries documented in the function's JSDoc comment.
3. Pass the new data from `detectOutfieldAssists` in `src/detection/detect.ts`. The detection function has access to the full live feed response, so any data from the API is available.
4. Add test cases in `src/detection/__tests__/ranking.test.ts` covering the new signal's contribution to the total score.

Example: to give bonus points for throws to home plate in the 9th inning or later, add an `isExtraInnings` boolean to `TierInput`, set it in `detect.ts`, and add a conditional point award in `calculateTier`.

## How to Add Notification Channels

The `processGame` function in `src/cli/scan.ts` returns `DetectedPlay[]`. To send notifications:

1. Create a new module (e.g., `src/notifications/slack.ts`) with a function that accepts `DetectedPlay[]`.
2. Format the plays however the channel expects (Slack blocks, Discord embeds, email HTML, RSS XML).
3. Call your notification function from `main()` in `scan.ts` after the plays are stored.

Keep the notification logic separate from detection. The detection pipeline should not know or care where results end up.

## How to Add CLI Flags

The argument parser lives in `parseArgs()` in `src/cli/scan.ts`. It is a simple loop over `Bun.argv`.

1. Add the new flag to the `CliArgs` interface.
2. Add a case in the `for` loop that matches your flag string (e.g., `"--team"`).
3. Use the parsed value downstream in `main()`.

The `queryPlays` function in `src/storage/db.ts` already supports several filters (date, team, tier, fielder, gamePk). If you are adding a filter flag, you may only need to wire it through.

## How to Change Detection Criteria

The detection signal check lives in `findOutfieldAssistCredit` in `src/detection/detect.ts`. Two values define what gets detected:

- `OUTFIELD_CODES`: a `Set` containing `"7"`, `"8"`, `"9"` (LF, CF, RF position codes)
- The string literal `"f_assist_of"` in the credit type check

To detect catcher assists, for example, you would add position code `"2"` and check for the appropriate credit type. To detect infield assists, you would look for `"f_assist"` instead of `"f_assist_of"`.

The `SKIP_EVENTS` set controls which play event types are filtered out. If you need to detect plays during appeals or substitution events, remove entries from this set, but be aware that stale assist credits on administrative events can produce false positives.

## How to Add Database Columns

1. Add the column to `CREATE_TABLE_SQL` in `src/storage/db.ts`.
2. Add the corresponding parameter to `INSERT_PLAY_SQL`.
3. Add the field to the `PlayRow` interface and the `rowToStoredPlay` mapping function.
4. Add the field to `DetectedPlay` in `src/types/play.ts`.
5. Populate the field in `detectOutfieldAssists` in `src/detection/detect.ts`.

If you are modifying an existing database, you need to handle migration manually. The simplest approach: delete the old database file and let the bot recreate it. For production use, write an `ALTER TABLE` migration.

## Known Limitations

- **Detection depends on MLB tagging.** The `f_assist_of` credit is assigned by MLB's official scorers and Statcast. If they do not tag a play, the bot does not detect it. There is no way to independently verify from the API data alone.
- **Video matching is best-effort.** Not every outfield assist gets its own highlight clip on the content endpoint. Some plays only appear in condensed game or recap videos that cannot be matched to individual plays. On the 2024-04-09 test date, 1 of 4 detected plays had no video match.
- **The ranking formula is opinionated.** A relay throw (`RF -> SS -> C`) gets no "direct throw" bonus even though relay plays can be more dramatic than direct pegs. The formula treats direct throws as harder, which is debatable.
- **Appeal plays are filtered but edge cases may exist.** The `SKIP_EVENTS` set excludes `"Runner Out"`, `"Game Advisory"`, and substitution events. If MLB introduces new event types that carry stale assist credits, they could slip through.
- **Spring training and exhibition games are excluded.** The schedule query defaults to `sportId=1,51` (MLB regular season/postseason + World Baseball Classic). Other sport IDs (minor league, spring training, exhibitions) are excluded by design. Pass a custom `sportIds` array to `fetchSchedule` to include other leagues.
- **No infield assist detection.** The bot only looks for `f_assist_of` (outfield). Catcher throws, pitcher fielding plays, and infield relays use different credit types and are ignored.

## Future Phases

### Phase 2: Daemon and Slack

A self-scheduling process that replaces the manual `bun run scan` workflow. What it involves:

- A loop that polls the schedule endpoint periodically and detects when games transition to `"Final"` state
- Tracking which games have been scanned to avoid duplicate processing
- A Slack webhook integration that formats `DetectedPlay` records as Slack block messages
- Configuration for the webhook URL, polling interval, and channel targeting
- Graceful shutdown handling

### Phase 3: REST API

An HTTP API for querying stored plays. What it involves:

- A `Bun.serve()` server with routes for listing plays, filtering by date/team/tier/fielder, and fetching individual play records
- JSON response formatting based on the existing `StoredPlay` type
- Pagination for large result sets
- Potential integration with the daemon from Phase 2 so the API serves live data
