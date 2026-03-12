# Janitor Bot: Project Overview

## What This Is

Janitor Bot scans MLB games and finds outfield assists. An outfield assist happens when an outfielder throws a baserunner out, usually at second base, third base, or home plate. These plays are rare, but they happen across 15 games a day during the regular season. No one watches every game. This tool watches the data instead.

The bot pulls play-by-play data from the MLB Stats API, scans fielding credits for a specific signal (`f_assist_of`), ranks each play by how dramatic it was, attempts to find a highlight video clip, and stores everything in a SQLite database. You can run it against any date or any single game.

The output is a structured `DetectedPlay` record for each outfield assist. Each record contains the fielder, runner, target base, inning, score, teams, play description, credit chain, drama tier, and a video URL when one exists. The `plays` table in SQLite holds everything for later querying.

For details on how the MLB Stats API exposes outfield assists, see [MLB API Guide](./mlb-api-guide.md). For the technical internals, see [Architecture](./architecture.md).

## Quick Start

**Prerequisites:** [Bun](https://bun.sh/) v1.0 or later.

**Install:**

```sh
git clone <repo-url>
cd janitor-bot
bun install
```

**Run a scan:**

```sh
# Scan yesterday's games (default)
bun run scan

# Scan a specific date
bun run scan -- --date 2024-04-09

# Scan a single game
bun run scan -- --game 745433 --date 2024-04-09
```

The `--date` flag is optional when using `--game`. The bot extracts the date from the live feed response if you leave it out.

**Environment variables:**

- `DB_PATH`: Path to the SQLite database file. Defaults to `./janitor-throws.db`.

## Output Format

```
[MEDIUM] CF Cody Bellinger - threw out runner at 3B
  CHC @ SD | 1st inning (top) | Score: 0-0
  "Fernando Tatis Jr. flies into a double play..."
  Video: https://...mp4

Found 4 outfield assists in 4 games
```

Each play prints on its own block with tier, position, fielder name, target base, game context, the play description from the API, and a video link when one was matched.

## Future Phases

**Phase 2: Daemon and Slack notifications.** A self-scheduling process that polls games as they finish throughout the day. When it detects an outfield assist, it sends a formatted message to a Slack channel via webhook. This removes the need to run the scanner manually.

**Phase 3: REST API.** An HTTP API for querying stored plays with filtering by date, team, tier, and fielder. Enables building dashboards or integrating with other tools without direct SQLite access.

See [Extending and Contributing](./extending.md) for more detail on what each phase involves and how to contribute.
