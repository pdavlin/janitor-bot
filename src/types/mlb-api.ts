/**
 * TypeScript types for the MLB Stats API.
 *
 * Covers three endpoints:
 *   - GET /api/v1/schedule
 *   - GET /api/v1.1/game/{gamePk}/feed/live
 *   - GET /api/v1/game/{gamePk}/content
 *
 * These types represent the subset of fields janitor-bot actually uses.
 * The real API responses contain many more fields; we only type what we read.
 */

// ---------------------------------------------------------------------------
// Shared / reusable primitives
// ---------------------------------------------------------------------------

/** The three top-level game states the schedule endpoint returns. */
export type GameState = "Final" | "Live" | "Preview";

/**
 * Position codes for the three outfield spots.
 *   7 = LF, 8 = CF, 9 = RF
 */
export type OutfieldPositionCode = "7" | "8" | "9";

// ---------------------------------------------------------------------------
// Schedule  (GET /api/v1/schedule?sportId=1&date=YYYY-MM-DD)
// ---------------------------------------------------------------------------

export interface ScheduleTeamInfo {
  id: number;
  name: string;
}

export interface ScheduleTeamEntry {
  team: ScheduleTeamInfo;
  score: number;
  isWinner: boolean;
}

export interface GameStatus {
  abstractGameState: GameState;
  codedGameState: string;
  detailedState: string;
  statusCode: string;
}

export interface ScheduleVenue {
  id: number;
  name: string;
}

export interface ScheduleGame {
  gamePk: number;
  gameType: string;
  season: string;
  /** ISO 8601 date-time string. */
  gameDate: string;
  status: GameStatus;
  teams: {
    away: ScheduleTeamEntry;
    home: ScheduleTeamEntry;
  };
  venue: ScheduleVenue;
}

export interface ScheduleDate {
  /** Formatted as YYYY-MM-DD. */
  date: string;
  totalGames: number;
  games: ScheduleGame[];
}

export interface ScheduleResponse {
  copyright: string;
  totalItems: number;
  totalGames: number;
  dates: ScheduleDate[];
}

// ---------------------------------------------------------------------------
// Live Feed  (GET /api/v1.1/game/{gamePk}/feed/live)
// ---------------------------------------------------------------------------

export interface Position {
  code: string;
  name: string;
  type: string;
  abbreviation: string;
}

export interface LiveFeedTeam {
  id: number;
  name: string;
  abbreviation: string;
  teamName: string;
}

export interface LiveFeedPlayer {
  id: number;
  fullName: string;
  primaryPosition: Position;
}

export interface PlayerReference {
  id: number;
  fullName: string;
}

export interface PlayResult {
  description: string;
  awayScore: number;
  homeScore: number;
  event: string;
  eventType: string;
}

export interface PlayAbout {
  inning: number;
  halfInning: string;
  atBatIndex: number;
}

export interface PlayMatchup {
  batter: PlayerReference;
}

export interface PlayMovement {
  originBase: string | null;
  start: string | null;
  end: string | null;
  /** Base where the out was recorded, e.g. "1B", "2B", "3B", "Home". */
  outBase: string | null;
  isOut: boolean;
  outNumber: number;
}

export interface RunnerCredit {
  player: { id: number };
  position: Position;
  /** Credit type, e.g. "f_assist_of", "f_putout", "f_assist". */
  credit: string;
}

export interface Runner {
  movement: PlayMovement;
  details: {
    runner: PlayerReference;
  };
  credits?: RunnerCredit[];
}

export interface PlayEvent {
  isPitch: boolean;
  playId?: string;
}

export interface PlayCount {
  outs: number;
}

export interface Play {
  about: PlayAbout;
  result: PlayResult;
  matchup: PlayMatchup;
  runners: Runner[];
  playEvents?: PlayEvent[];
  count?: PlayCount;
}

export interface BoxscorePlayerEntry {
  person: PlayerReference;
  position: Position;
}

export interface BoxscoreTeam {
  players: Record<string, BoxscorePlayerEntry>;
}

export interface LiveFeedResponse {
  gameData: {
    datetime?: {
      /** Game date as YYYY-MM-DD. */
      officialDate: string;
    };
    teams: {
      away: LiveFeedTeam;
      home: LiveFeedTeam;
    };
    /** Keyed like "ID123456". */
    players: Record<string, LiveFeedPlayer>;
  };
  liveData: {
    plays: {
      allPlays: Play[];
    };
    boxscore: {
      teams: {
        away: BoxscoreTeam;
        home: BoxscoreTeam;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Content  (GET /api/v1/game/{gamePk}/content)
// ---------------------------------------------------------------------------

export interface Keyword {
  /** e.g. "game", "player", "team", "taxonomy". */
  type: string;
  /** e.g. "playerid-676962", "taxonomy-defense". */
  value: string;
  displayName: string;
}

export interface Playback {
  /** e.g. "mp4Avc", "hlsCloud", "highBit". */
  name: string;
  url: string;
  width: string;
  height: string;
}

export interface HighlightItem {
  title: string;
  description: string;
  keywordsAll?: Keyword[];
  playbacks?: Playback[];
}

export interface ContentResponse {
  highlights?: {
    highlights?: {
      items?: HighlightItem[];
    };
  };
}
