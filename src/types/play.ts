/**
 * Shared types for detected and stored outfield assist plays.
 *
 * Previously duplicated across detection/detect.ts and storage/db.ts.
 * Centralised here so every module references a single source of truth.
 */

/** Tier classification for a detected play based on outfield assist quality. */
export type Tier = "high" | "medium" | "low";

/**
 * A play detected by the scanning pipeline before storage.
 *
 * One record per runner thrown out with an outfield assist credit.
 */
export interface DetectedPlay {
  gamePk: number;
  /** atBatIndex from the play's about block. */
  playIndex: number;
  /** Game date formatted as YYYY-MM-DD. */
  date: string;
  fielderId: number;
  fielderName: string;
  /** Position abbreviation: "LF", "CF", or "RF". */
  fielderPosition: string;
  runnerId: number;
  runnerName: string;
  /** Where the runner was thrown out: "2B", "3B", or "Home". */
  targetBase: string;
  batterName: string;
  inning: number;
  /** "top" or "bottom". */
  halfInning: string;
  awayScore: number;
  homeScore: number;
  /** Team abbreviation, e.g. "CHC". */
  awayTeam: string;
  homeTeam: string;
  description: string;
  /** Full credit chain, e.g. "RF -> 2B -> C". */
  creditChain: string;
  tier: Tier;
  /** Number of outs before the play. */
  outs: number;
  /** Comma-separated base positions with runners, e.g. "1st, 2nd". Empty string if bases empty. */
  runnersOn: string;
  /** Populated later by video-match module. */
  videoUrl: string | null;
  /** Populated later by video-match module. */
  videoTitle: string | null;
}

/**
 * A play retrieved from storage, including its auto-generated id
 * and creation timestamp.
 */
export interface StoredPlay extends DetectedPlay {
  id: number;
  createdAt: string;
}
