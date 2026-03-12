# Technical Architecture

Technical reference for janitor-bot's detection pipeline, module structure, ranking system, and storage layer. For the MLB Stats API data model that this code operates on, see [MLB API Guide](./mlb-api-guide.md).

## Pipeline Data Flow

Data flows through eight stages for each scan.

```
MLB Schedule API ──> Filter completed games
                          |
                     For each game:
                          |
                    Live Feed API ──> Scan plays for f_assist_of
                          |                    |
                    Content API ──>  Match video highlights
                          |
                     Rank by throw tier
                          |
                     Store in SQLite
                          |
              ┌───────────┴───────────┐
              |                       |
         Print to stdout       Slack notification
         (CLI mode)            (daemon mode)
```

1. **Schedule fetch.** Calls `/api/v1/schedule?sportId=1,51&date=YYYY-MM-DD` (MLB + WBC by default) and filters to games where `status.abstractGameState === "Final"`.
2. **Live feed fetch.** For each completed game, fetches `/api/v1.1/game/{gamePk}/feed/live` for full play-by-play data.
3. **Detection scan.** Iterates through `allPlays`, checking each runner's credits array for the `f_assist_of` signal from an outfield position.
4. **Context extraction.** Resolves fielder names, normalizes bases, builds credit chains, and pulls game context (inning, score, teams).
5. **Tier ranking.** Scores each play by throw distance and directness, then assigns a tier (high, medium, low).
6. **Video matching.** Fetches `/api/v1/game/{gamePk}/content` and attempts to match highlight clips. This step is best-effort. If the content fetch fails, plays are kept with null video fields.
7. **Storage.** Inserts all plays into SQLite in a single transaction.
8. **Output.** In CLI mode, prints results to stdout. In daemon mode, sends Slack notifications for plays meeting the configured minimum tier.

## Project Structure

```
janitor-bot/
  src/
    api/
      mlb-client.ts         # HTTP client with retry + rate limiting
    cli/
      daemon.ts             # Daemon entry point with signal handling
      scan.ts               # CLI entry point (--date, --game)
    config.ts               # Environment variable parsing
    daemon/
      scheduler.ts          # Self-scheduling game state machine
    detection/
      detect.ts             # Core f_assist_of detection logic
      ranking.ts            # Throw tier scoring
      video-match.ts        # Highlight video matching
      __tests__/
        detect.test.ts      # Detection unit tests
        ranking.test.ts     # Ranking unit tests
    logger.ts               # Structured JSON logging
    notifications/
      slack.ts              # Slack webhook with Block Kit formatting
    pipeline.ts             # Shared detection pipeline (processGame, scanDate)
    storage/
      db.ts                 # SQLite persistence layer
    types/
      mlb-api.ts            # MLB Stats API response types
      play.ts               # DetectedPlay, StoredPlay, Tier
```

## Module Responsibilities

**`src/api/mlb-client.ts`** handles all HTTP communication with the MLB Stats API. Exports `fetchSchedule(date)`, `fetchLiveFeed(gamePk)`, `fetchGameContent(gamePk)`, and `getCompletedGames(schedule)`. Uses a semaphore-based concurrency limiter and exponential backoff for retries. See the HTTP Client section below for details.

**`src/config.ts`** parses environment variables (SLACK_WEBHOOK_URL, POLL_INTERVAL_MINUTES, DB_PATH, MIN_TIER, LOG_LEVEL) with validation. Returns a typed Config object. Missing required variables cause an immediate exit with a descriptive error.

**`src/logger.ts`** provides structured JSON logging with configurable level filtering. Each log line is a JSON object with timestamp, level, message, and optional data fields. Log levels follow the standard hierarchy: debug, info, warn, error.

**`src/cli/scan.ts`** is the CLI entry point. Parses `--date` and `--game` flags, delegates to the shared pipeline functions in `pipeline.ts`, and handles error reporting. The core detection logic (`processGame` and `scanDate`) was extracted to `pipeline.ts` so it can be reused by the daemon.

**`src/cli/daemon.ts`** is the entry point for the daemon process. Loads config via `config.ts`, initializes the logger and database, starts the scheduler, and handles SIGINT/SIGTERM for graceful shutdown.

**`src/pipeline.ts`** contains the shared detection pipeline extracted from the CLI. Exports `processGame(gamePk, gameDate, logger)` and `scanDate(date, logger)`. Both return `DetectedPlay[]` arrays. Used by the CLI scanner and the daemon scheduler.

**`src/daemon/scheduler.ts`** is a self-scheduling daemon that tracks games through states (pending, live, final, abandoned). Polls the MLB schedule API on a configurable interval, runs detection when games reach Final, stores results, and sends Slack notifications for plays meeting the configured minimum tier.

**`src/notifications/slack.ts`** handles Slack webhook integration. Builds Block Kit formatted messages, batches multiple assists from the same game into single messages, and retries failed deliveries with exponential backoff.

**`src/detection/detect.ts`** contains the core detection logic. The `detectOutfieldAssists(liveFeed, gamePk, gameDate)` function scans every play in a game's live feed, checks each runner's credits for `f_assist_of` from an outfield position, and builds a `DetectedPlay` record for each match. Helper functions handle player name resolution (`resolvePlayerName`), base normalization (`normalizeBase`), credit chain formatting (`buildCreditChain`), and the outfield assist credit lookup (`findOutfieldAssistCredit`). See the [MLB API Guide](./mlb-api-guide.md) for the detection signal explained in full.

**`src/detection/ranking.ts`** assigns throw tiers. The `calculateTier(play)` function takes a `TierInput` object (target base, credit chain) and returns a `Tier` value. The scoring is based on throw distance and directness, not game situation. See the Ranking System section below for the scoring table.

**`src/detection/video-match.ts`** matches highlight videos to detected plays. The `matchVideoToPlay(content, play)` function tries keyword-based matching first, then falls back to description substring overlap. Returns a `VideoMatch` with URL and title, or null. See the Video Matching Strategy section below.

**`src/storage/db.ts`** manages SQLite persistence using `bun:sqlite`. Exports `createDatabase(path)`, `insertPlay(db, play)`, `insertPlays(db, plays)`, and `queryPlays(db, filters)`. See the Storage Layer section below.

**`src/types/mlb-api.ts`** defines TypeScript types for the three MLB Stats API responses. Only types the fields the bot reads. The real API responses contain many more fields.

**`src/types/play.ts`** defines `DetectedPlay` (output of the detection pipeline), `StoredPlay` (a `DetectedPlay` with `id` and `createdAt` from the database), and the `Tier` union type (`"high" | "medium" | "low"`). These types are the shared contract between detection, storage, and CLI modules.

## The Ranking System

Each outfield assist gets a numeric score based on two factors: how far the throw traveled (target base) and whether the outfielder threw directly or through a relay. The ranking prioritizes throw distance and directness over game situation, since the goal is identifying impressive physical throws regardless of context.

### Point System

| Factor | Condition | Points |
|--------|-----------|--------|
| Target base | Home plate | 4 |
| Target base | 3B | 3 |
| Target base | 2B | 1 |
| Throw type | Direct (2 fielders in chain) | 2 |
| Throw type | Relay (3+ fielders) | 0 |

### Tier Boundaries

- **HIGH** = 5+ points
- **MEDIUM** = 3 to 4 points
- **LOW** = 0 to 2 points

A credit chain with exactly two segments (like `"CF -> 3B"`) means the outfielder threw directly to the fielder who tagged the runner. Three or more segments (like `"RF -> SS -> C"`) means a relay or cutoff was involved.

### Scored Examples from 2024-04-09

**Bellinger throw (CHC @ SD, game 745433):**
- Target base: 3B = 3 points
- Credit chain had 3+ segments (relay through a cutoff man) = 0 points
- Total: 3 = MEDIUM

**Duran throw (BAL @ BOS, game 746981):**
- Target base: 2B = 1 point
- Relay throw = 0 points
- Total: 1 = LOW

**Laureano throw (CWS @ CLE, game 746653):**
- Target base: 3B = 3 points
- Direct throw (2 fielders in chain) = 2 points
- Total: 5 = HIGH

**Kelenic throw (NYM @ ATL, game 747138):**
- Target base: 2B = 1 point
- Direct throw (2 fielders in chain) = 2 points
- Total: 3 = MEDIUM

## Video Matching Strategy

### Primary Match

The `matchVideoToPlay` function looks for a highlight where `keywordsAll` contains both:
- A keyword referencing the fielder's player ID. The API uses two formats: `type: "player_id"` with `value: "676962"`, or `type: "player"` with `value: "playerid-676962"`. The code checks for exact matches on both formats to avoid substring collisions.
- A keyword with `"defense"` in its value, typically `type: "taxonomy"` with `value: "taxonomy-defense"`.

Both conditions must be true for a primary match.

### Fallback Match

If no keyword match is found, the code tries description substring matching. It slides a 20-character window across the play description and checks whether any substring appears in the highlight's description. This catches cases where keyword metadata is sparse, but it can produce false positives when play descriptions share common phrases.

### URL Selection

Each highlight item has a `playbacks` array with multiple video formats. The code prefers:
1. `mp4Avc` (best quality MP4)
2. Any playback with `"mp4"` in the name
3. First available URL as a last resort

## Storage Layer

Uses `bun:sqlite` (built into the Bun runtime, no external dependencies).

### Schema

The `plays` table has 22 columns: `id` (auto-increment primary key), `game_pk`, `play_index`, `date`, `fielder_id`, `fielder_name`, `fielder_position`, `runner_id`, `runner_name`, `target_base`, `batter_name`, `inning`, `half_inning`, `away_score`, `home_score`, `away_team`, `home_team`, `description`, `credit_chain`, `tier`, `video_url`, `video_title`, and `created_at`.

WAL mode is enabled for concurrent read performance.

### Dedup Key

A `UNIQUE(game_pk, play_index, runner_id)` constraint prevents duplicate rows when scanning the same game twice. The three-part key allows multiple runners to be thrown out on the same play (e.g., a double play where the outfielder nails two runners).

### Upsert Strategy

Inserts use `ON CONFLICT DO UPDATE` with `COALESCE` on video fields:

```sql
ON CONFLICT(game_pk, play_index, runner_id) DO UPDATE SET
  video_url   = COALESCE(excluded.video_url, plays.video_url),
  video_title = COALESCE(excluded.video_title, plays.video_title),
  tier        = excluded.tier;
```

A rescan can backfill video URLs without overwriting existing video data. If a previous scan found a video but the current scan did not match one, the existing URL is preserved. The tier is always refreshed in case the ranking formula changes.

### Query Interface

The `queryPlays` function accepts optional filters: `date`, `team` (matches either away or home), `tier`, `fielder` (partial name match via `LIKE`), and `gamePk`. Results are ordered by date descending, then inning ascending, then play index ascending.

## HTTP Client

The MLB API client (`mlb-client.ts`) uses native `fetch` with two layers of protection.

**Concurrency limiting.** A semaphore caps in-flight requests at 10. When all slots are taken, new requests wait in a FIFO queue until a slot frees up. The slot is handed directly to the next waiter without decrementing and re-incrementing the counter.

**Retry with backoff.** Server errors (5xx) and network failures are retried up to 3 times with exponential backoff (1s, 2s, 4s). Client errors (4xx) are not retried. The `MlbApiError` class carries the HTTP status and URL for debugging.

## Type Architecture

Types are split across two files for a clear separation of concerns.

**`mlb-api.ts`** covers the three MLB API endpoint responses (schedule, live feed, content). These types represent the subset of fields the bot reads. The real API responses contain many more fields. Only the consumed fields are typed.

**`play.ts`** defines the bot's own domain types:
- `DetectedPlay`: the output of the detection pipeline, one record per runner thrown out
- `StoredPlay`: a `DetectedPlay` extended with `id` and `createdAt` from the database
- `Tier`: the union type `"high" | "medium" | "low"`

This separation means the API types can change without affecting the domain model, and vice versa. The `detect.ts` module is the bridge that transforms API types into `DetectedPlay` records.
