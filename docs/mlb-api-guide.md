# How Outfield Assists Appear in MLB Data

A standalone reference for understanding how the MLB Stats API represents outfield assists in its play-by-play data. This guide covers the three endpoints, the data model for plays and fielding credits, video highlights, and the quirks you will run into.

## The Three API Endpoints

### Schedule

```
GET https://statsapi.mlb.com/api/v1/schedule?sportId=1,51&date=YYYY-MM-DD
```

Returns every game for the given date matching the specified sport IDs. The bot defaults to `sportId=1,51` which covers Major League Baseball regular season/postseason (1) and World Baseball Classic (51). This excludes minor league, spring training, and exhibition games.

Key fields:
- `dates[].games[]` contains one entry per game
- `games[].gamePk` is the unique game identifier used by the other two endpoints
- `games[].status.abstractGameState` is one of `"Final"`, `"Live"`, or `"Preview"`
- `games[].gameDate` is an ISO 8601 timestamp like `"2024-04-09T23:10:00Z"`
- `games[].teams.away` and `games[].teams.home` have team names and scores

### Live Feed

```
GET https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live
```

Returns the full play-by-play log, boxscore, and game metadata for a single game. This is the primary data source for detecting outfield assists.

Key fields:
- `liveData.plays.allPlays[]` is the play-by-play array (one entry per at-bat)
- `gameData.teams.away` and `gameData.teams.home` have team abbreviations and names
- `gameData.players` is a lookup map for player details, keyed as `"ID{playerId}"` (see Player ID Resolution below)
- `gameData.datetime.officialDate` is the game date as `YYYY-MM-DD`

### Content

```
GET https://statsapi.mlb.com/api/v1/game/{gamePk}/content
```

Returns media content for a game, including highlight video clips.

Key fields:
- `highlights.highlights.items[]` is the list of highlight clips
- Each item has `title`, `description`, `keywordsAll[]`, and `playbacks[]`
- See the Video Highlights section below for the full structure

## The Play-by-Play Data Model

Each entry in `allPlays` represents one at-bat. The structure that matters for outfield assist detection:

```
allPlays[n]
  about
    inning: number
    halfInning: "top" | "bottom"
    atBatIndex: number
  result
    description: string     (human-readable play description)
    awayScore: number
    homeScore: number
    event: string           (e.g., "Double Play", "Flyout")
    eventType: string
  matchup
    batter
      id: number
      fullName: string
  runners[]
    movement
      originBase: string | null
      start: string | null
      end: string | null
      outBase: string | null    (base where the out was recorded)
      isOut: boolean
      outNumber: number
    details
      runner
        id: number
        fullName: string
    credits[]                   (optional, present when fielders are involved)
      credit: string            (e.g., "f_assist_of", "f_putout", "f_assist")
      player
        id: number
      position
        code: string            (e.g., "7", "8", "9")
        abbreviation: string    (e.g., "LF", "CF", "RF")
```

The `runners` array holds one entry per baserunner movement during the at-bat. A single at-bat can have multiple runner entries (the batter reaching first while another runner advances, for example).

## The f_assist_of Signal

An outfield assist is detected when three conditions are true on a runner entry:

1. `movement.isOut === true` (the runner was called out)
2. `credits[]` contains an entry with `credit === "f_assist_of"` (fielding assist, outfield variant)
3. That credit's `position.code` is `"7"`, `"8"`, or `"9"` (LF, CF, RF)

### The Bellinger Example

On 2024-04-09, game 745433 (CHC @ SD), Fernando Tatis Jr. flew out and Cody Bellinger fielded the ball in center. Xander Bogaerts was trying to tag up from second to third. Bellinger threw to Christopher Morel at 3B and got Bogaerts out.

In the API data, the runner entry for Bogaerts has:

```
movement.isOut: true
movement.outBase: "3B"
credits: [
  { credit: "f_assist_of", position: { code: "8", abbreviation: "CF" } },
  { credit: "f_putout",    position: { code: "5", abbreviation: "3B" } }
]
```

The `f_assist_of` on position code `"8"` is the signal. Bellinger (CF) made the throw. Morel (3B) recorded the putout.

The credit chain for this play reads `"CF -> 3B"`, meaning two fielders were involved in the putout sequence. If a relay or cutoff man was in the mix, the chain would have three or more segments (e.g., `"RF -> SS -> C"`).

## What Does NOT Trigger Detection

- **`f_putout` alone.** A catcher catching a strikeout or an outfielder catching a fly ball. No throw to a base.
- **`f_assist` without the `_of` suffix.** An infielder relaying a throw. The shortstop flipping to second on a ground ball has `f_assist`, not `f_assist_of`.
- **`f_assist_of` on an outfielder but `isOut: false`.** The outfielder threw but the runner was safe. Close play, but not an assist.
- **Appeal plays and administrative events.** Plays with event types like `"Runner Out"`, `"Game Advisory"`, `"Pitching Substitution"`, `"Defensive Sub"`, or `"Offensive Sub"` can carry assist credits from earlier action. These are skipped because they represent re-scored or administrative entries, not real thrown-out-on-bases plays.

## Video Highlights

Each highlight item in the content response has this structure:

```
items[n]
  title: string              ("Bellinger's outfield assist")
  description: string        (longer play description)
  keywordsAll[]
    type: string             ("player_id", "player", "taxonomy", "team", "game")
    value: string            ("676962", "playerid-676962", "taxonomy-defense")
    displayName: string
  playbacks[]
    name: string             ("mp4Avc", "hlsCloud", "highBit")
    url: string
    width: string
    height: string
```

The `keywordsAll` array is the primary way to match a highlight to a specific play. See [Architecture](./architecture.md) for the matching algorithm.

Not every outfield assist gets its own highlight clip. Some plays only appear in condensed game or recap videos, which cannot be matched to individual plays. On the 2024-04-09 test date, 3 of 4 detected plays had video matches. That ratio is typical.

## Player ID Resolution

The `credits` array on a runner entry only contains `player.id` as a number. It does not include the player's name. To resolve the name, look up `gameData.players` using the key format `"ID{playerId}"`.

```ts
// The API keys players as "ID{id}", e.g. "ID676962"
const player = liveFeed.gameData.players[`ID${credit.player.id}`];
const name = player?.fullName ?? "Unknown";
```

Runner names are easier. The `runner.details.runner` object already includes `fullName` directly.

## Gotchas and Quirks

**`outBase` can be null.** A runner entry with `isOut: true` but `outBase: null` is suspicious data. It happens occasionally and should be skipped rather than treated as a valid play at an unknown base.

**"score" vs "Home".** The API sometimes uses `"score"` instead of `"Home"` for the `outBase` value on plays at home plate. Normalize both to `"Home"` when displaying or scoring.

**Optional fields.** The `credits` array on a runner is optional. Not all runner movements involve fielding credits. Always check for its existence before iterating.

**Keyword format variations for player matching.** The content API uses two keyword formats for player IDs:
- `type: "player_id"` with `value: "676962"` (raw number string)
- `type: "player"` with `value: "playerid-676962"` (prefixed format)

Use exact string matching on both formats. Substring matching causes false positives when one player ID is a suffix of another (e.g., player ID 234 matching the string "12345").

**The highlights object is doubly nested.** The path to highlight items is `content.highlights.highlights.items`. Both levels of `highlights` can be undefined or null.

**`sportId` matters.** The bot queries `sportId=1,51` by default (MLB + WBC). Without a sportId filter, you get minor league, spring training, and exhibition games mixed in. These games have different data quality and are excluded by design. The `fetchSchedule` function accepts a custom `sportIds` array if you need to change which leagues are included.
