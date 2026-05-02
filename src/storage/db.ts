/**
 * SQLite storage layer for detected outfield assist plays.
 *
 * Uses bun:sqlite for persistence and deduplication. The UNIQUE constraint
 * on (game_pk, play_index, runner_id) prevents duplicate entries when
 * re-scanning the same game data while allowing multiple runners thrown
 * out on the same play (e.g., double plays).
 *
 * FR-1.13: Create/open SQLite database with plays table
 * FR-1.14: Insert plays with deduplication via ON CONFLICT ... DO UPDATE
 * FR-1.15: Query plays with optional filters
 */

import { Database } from "bun:sqlite";
import type { Tier, FetchStatus, DetectedPlay, StoredPlay } from "../types/play";

export type { DetectedPlay, StoredPlay } from "../types/play";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Optional filters for querying stored plays.
 * All fields are optional; omitted fields impose no constraint.
 */
export interface PlayFilters {
  /** Exact match on date (YYYY-MM-DD). */
  date?: string;
  /** Matches either away_team or home_team. */
  team?: string;
  /** Exact match on tier (high, medium, low). */
  tier?: Tier;
  /** Partial match on fielder_name (LIKE '%value%'). */
  fielder?: string;
  /** Exact match on game_pk. */
  gamePk?: number;
  /** Start of date range, inclusive (YYYY-MM-DD). */
  from?: string;
  /** End of date range, inclusive (YYYY-MM-DD). */
  to?: string;
  /** Exact match on fielder_position (LF/CF/RF). */
  position?: string;
  /** Exact match on target_base (2B/3B/Home). */
  base?: string;
  /** Max results returned. Default 50, max 200. */
  limit?: number;
  /** Pagination offset. */
  offset?: number;
}

export interface PlayStats {
  totalByTier: { tier: string; count: number }[];
  topFielders: { fielderName: string; count: number }[];
  playsByTeam: { team: string; count: number }[];
}

export interface DbStats {
  totalPlays: number;
  dbSizeBytes: number;
  oldestPlay: string | null;
  newestPlay: string | null;
}

// ---------------------------------------------------------------------------
// Raw row shape returned by SELECT queries
// ---------------------------------------------------------------------------

interface PlayRow {
  id: number;
  game_pk: number;
  play_index: number;
  date: string;
  fielder_id: number;
  fielder_name: string;
  fielder_position: string;
  runner_id: number;
  runner_name: string;
  target_base: string;
  batter_name: string;
  inning: number;
  half_inning: string;
  away_score: number;
  home_score: number;
  away_team: string;
  home_team: string;
  description: string;
  credit_chain: string;
  tier: Tier;
  outs: number;
  runners_on: string;
  video_url: string | null;
  video_title: string | null;
  play_id: string | null;
  fetch_status: FetchStatus | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS plays (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_pk         INTEGER NOT NULL,
  play_index      INTEGER NOT NULL,
  date            TEXT    NOT NULL,
  fielder_id      INTEGER NOT NULL,
  fielder_name    TEXT    NOT NULL,
  fielder_position TEXT   NOT NULL,
  runner_id       INTEGER NOT NULL,
  runner_name     TEXT    NOT NULL,
  target_base     TEXT    NOT NULL,
  batter_name     TEXT    NOT NULL,
  inning          INTEGER NOT NULL,
  half_inning     TEXT    NOT NULL,
  away_score      INTEGER NOT NULL,
  home_score      INTEGER NOT NULL,
  away_team       TEXT    NOT NULL,
  home_team       TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  credit_chain    TEXT    NOT NULL,
  tier            TEXT    NOT NULL,
  video_url       TEXT,
  video_title     TEXT,
  play_id         TEXT,
  fetch_status    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(game_pk, play_index, runner_id)
);
`;

const CREATE_SLACK_GAME_HEADERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS slack_game_headers (
  game_pk         INTEGER PRIMARY KEY,
  channel         TEXT    NOT NULL,
  ts              TEXT    NOT NULL,
  posted_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  last_updated_at TEXT
);
`;

const CREATE_SLACK_PLAY_MESSAGES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS slack_play_messages (
  game_pk         INTEGER NOT NULL,
  play_index      INTEGER NOT NULL,
  channel         TEXT    NOT NULL,
  ts              TEXT    NOT NULL,
  parent_ts       TEXT    NOT NULL,
  posted_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  last_updated_at TEXT,
  PRIMARY KEY (game_pk, play_index)
);
`;

const INSERT_PLAY_SQL = `
INSERT INTO plays (
  game_pk, play_index, date, fielder_id, fielder_name, fielder_position,
  runner_id, runner_name, target_base, batter_name, inning, half_inning,
  away_score, home_score, away_team, home_team, description, credit_chain,
  tier, outs, runners_on, video_url, video_title, play_id, fetch_status
) VALUES (
  $gamePk, $playIndex, $date, $fielderId, $fielderName, $fielderPosition,
  $runnerId, $runnerName, $targetBase, $batterName, $inning, $halfInning,
  $awayScore, $homeScore, $awayTeam, $homeTeam, $description, $creditChain,
  $tier, $outs, $runnersOn, $videoUrl, $videoTitle, $playId, $fetchStatus
)
ON CONFLICT(game_pk, play_index, runner_id) DO UPDATE SET
  video_url    = COALESCE(excluded.video_url, plays.video_url),
  video_title  = COALESCE(excluded.video_title, plays.video_title),
  tier         = excluded.tier,
  outs         = excluded.outs,
  runners_on   = excluded.runners_on,
  play_id      = COALESCE(excluded.play_id, plays.play_id),
  fetch_status = excluded.fetch_status;
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates or opens a SQLite database at the given path and ensures the
 * plays table exists.
 *
 * @param dbPath - File system path for the SQLite database file.
 *                 Use ":memory:" for an in-memory database (useful in tests).
 * @returns The opened Database instance with WAL mode enabled.
 */
export function createDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run(CREATE_TABLE_SQL);
  db.run("CREATE INDEX IF NOT EXISTS idx_plays_date ON plays(date);");
  db.run("CREATE INDEX IF NOT EXISTS idx_plays_tier ON plays(tier);");
  db.run("CREATE INDEX IF NOT EXISTS idx_plays_fielder_name ON plays(fielder_name);");
  db.run("CREATE INDEX IF NOT EXISTS idx_plays_away_team ON plays(away_team);");
  db.run("CREATE INDEX IF NOT EXISTS idx_plays_home_team ON plays(home_team);");

  try {
    db.run("ALTER TABLE plays ADD COLUMN outs INTEGER NOT NULL DEFAULT 0;");
  } catch (_) { /* column already exists */ }
  try {
    db.run("ALTER TABLE plays ADD COLUMN runners_on TEXT NOT NULL DEFAULT '';");
  } catch (_) { /* column already exists */ }
  try {
    db.run("ALTER TABLE plays ADD COLUMN play_id TEXT;");
  } catch (_) { /* column already exists */ }
  try {
    db.run("ALTER TABLE plays ADD COLUMN fetch_status TEXT;");
  } catch (_) { /* column already exists */ }

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_plays_video_url_null ON plays(date) WHERE video_url IS NULL;",
  );

  db.run("DROP TABLE IF EXISTS slack_messages;");
  db.run(CREATE_SLACK_GAME_HEADERS_TABLE_SQL);
  db.run(CREATE_SLACK_PLAY_MESSAGES_TABLE_SQL);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_slack_play_messages_ts ON slack_play_messages(channel, ts);",
  );

  return db;
}

/**
 * Inserts a single play into the database. On conflict (same game_pk,
 * play_index, runner_id), updates video fields via COALESCE (preserving
 * existing video data when the new row has nulls) and always refreshes tier.
 *
 * @param db   - An open Database instance returned by createDatabase.
 * @param play - The detected play to store.
 */
export function insertPlay(db: Database, play: DetectedPlay): void {
  const stmt = db.prepare(INSERT_PLAY_SQL);
  stmt.run({
    $gamePk: play.gamePk,
    $playIndex: play.playIndex,
    $date: play.date,
    $fielderId: play.fielderId,
    $fielderName: play.fielderName,
    $fielderPosition: play.fielderPosition,
    $runnerId: play.runnerId,
    $runnerName: play.runnerName,
    $targetBase: play.targetBase,
    $batterName: play.batterName,
    $inning: play.inning,
    $halfInning: play.halfInning,
    $awayScore: play.awayScore,
    $homeScore: play.homeScore,
    $awayTeam: play.awayTeam,
    $homeTeam: play.homeTeam,
    $description: play.description,
    $creditChain: play.creditChain,
    $tier: play.tier,
    $outs: play.outs,
    $runnersOn: play.runnersOn,
    $videoUrl: play.videoUrl,
    $videoTitle: play.videoTitle,
    $playId: play.playId,
    $fetchStatus: play.fetchStatus,
  });
}

/**
 * Inserts multiple plays in a single transaction for performance.
 * On conflict, updates video fields and tier (see insertPlay).
 *
 * @param db    - An open Database instance returned by createDatabase.
 * @param plays - Array of detected plays to store.
 */
export function insertPlays(db: Database, plays: DetectedPlay[]): void {
  if (plays.length === 0) return;

  const stmt = db.prepare(INSERT_PLAY_SQL);

  const transaction = db.transaction(() => {
    for (const play of plays) {
      stmt.run({
        $gamePk: play.gamePk,
        $playIndex: play.playIndex,
        $date: play.date,
        $fielderId: play.fielderId,
        $fielderName: play.fielderName,
        $fielderPosition: play.fielderPosition,
        $runnerId: play.runnerId,
        $runnerName: play.runnerName,
        $targetBase: play.targetBase,
        $batterName: play.batterName,
        $inning: play.inning,
        $halfInning: play.halfInning,
        $awayScore: play.awayScore,
        $homeScore: play.homeScore,
        $awayTeam: play.awayTeam,
        $homeTeam: play.homeTeam,
        $description: play.description,
        $creditChain: play.creditChain,
        $tier: play.tier,
        $outs: play.outs,
        $runnersOn: play.runnersOn,
        $videoUrl: play.videoUrl,
        $videoTitle: play.videoTitle,
        $playId: play.playId,
        $fetchStatus: play.fetchStatus,
      });
    }
  });

  transaction();
}

/**
 * Converts a snake_case database row into a camelCase StoredPlay object.
 */
function rowToStoredPlay(row: PlayRow): StoredPlay {
  return {
    id: row.id,
    gamePk: row.game_pk,
    playIndex: row.play_index,
    date: row.date,
    fielderId: row.fielder_id,
    fielderName: row.fielder_name,
    fielderPosition: row.fielder_position,
    runnerId: row.runner_id,
    runnerName: row.runner_name,
    targetBase: row.target_base,
    batterName: row.batter_name,
    inning: row.inning,
    halfInning: row.half_inning,
    awayScore: row.away_score,
    homeScore: row.home_score,
    awayTeam: row.away_team,
    homeTeam: row.home_team,
    description: row.description,
    creditChain: row.credit_chain,
    tier: row.tier,
    outs: row.outs,
    runnersOn: row.runners_on,
    videoUrl: row.video_url,
    videoTitle: row.video_title,
    playId: row.play_id,
    fetchStatus: row.fetch_status,
    createdAt: row.created_at,
  };
}

function buildWhereClause(filters?: PlayFilters): {
  whereClause: string;
  params: Record<string, string | number>;
} {
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (filters?.date) {
    conditions.push("date = $date");
    params.$date = filters.date;
  }

  if (filters?.team) {
    conditions.push("(away_team = $team OR home_team = $team)");
    params.$team = filters.team;
  }

  if (filters?.tier) {
    conditions.push("tier = $tier");
    params.$tier = filters.tier;
  }

  if (filters?.fielder) {
    conditions.push("fielder_name LIKE $fielder");
    params.$fielder = `%${filters.fielder}%`;
  }

  if (filters?.gamePk) {
    conditions.push("game_pk = $gamePk");
    params.$gamePk = filters.gamePk;
  }

  if (filters?.from) {
    conditions.push("date >= $from");
    params.$from = filters.from;
  }

  if (filters?.to) {
    conditions.push("date <= $to");
    params.$to = filters.to;
  }

  if (filters?.position) {
    conditions.push("fielder_position = $position");
    params.$position = filters.position;
  }

  if (filters?.base) {
    conditions.push("target_base = $base");
    params.$base = filters.base;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return { whereClause, params };
}

/**
 * Queries stored plays with optional filters. Results are ordered by
 * date descending, then inning ascending, then play_index ascending.
 *
 * @param db      - An open Database instance returned by createDatabase.
 * @param filters - Optional filter criteria. Omit or pass undefined for all plays.
 * @returns Array of StoredPlay objects matching the filters.
 *
 * @example
 *   // All high-tier plays from a specific date
 *   const plays = queryPlays(db, { date: "2025-06-15", tier: "high" });
 *
 *   // All plays involving a specific fielder
 *   const plays = queryPlays(db, { fielder: "Betts" });
 */
export function queryPlays(
  db: Database,
  filters?: PlayFilters,
): StoredPlay[] {
  const { whereClause, params } = buildWhereClause(filters);

  const limit = Math.min(filters?.limit ?? 50, 200);
  const offset = filters?.offset ?? 0;

  const sql = `
    SELECT * FROM plays
    ${whereClause}
    ORDER BY date DESC, inning ASC, play_index ASC
    LIMIT $limit OFFSET $offset;
  `;

  const stmt = db.prepare(sql);
  const rows = stmt.all({ ...params, $limit: limit, $offset: offset }) as PlayRow[];
  return rows.map(rowToStoredPlay);
}

/**
 * Returns the total count of plays matching the given filters,
 * ignoring limit/offset. Useful for pagination metadata.
 */
export function queryPlayCount(db: Database, filters?: PlayFilters): number {
  const { whereClause, params } = buildWhereClause(filters);

  const sql = `SELECT COUNT(*) as count FROM plays ${whereClause};`;
  const row = db.prepare(sql).get(params) as { count: number };
  return row.count;
}

/**
 * Fetches a single play by its primary key id.
 * Returns null when no row matches.
 */
export function queryPlayById(db: Database, id: number): StoredPlay | null {
  const row = db
    .prepare("SELECT * FROM plays WHERE id = $id;")
    .get({ $id: id }) as PlayRow | null;
  return row ? rowToStoredPlay(row) : null;
}

/**
 * Aggregated statistics about stored plays, optionally filtered by date range.
 */
export function queryPlayStats(db: Database, from?: string, to?: string): PlayStats {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (from) {
    conditions.push("date >= $from");
    params.$from = from;
  }
  if (to) {
    conditions.push("date <= $to");
    params.$to = to;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalByTier = db
    .prepare(`SELECT tier, COUNT(*) as count FROM plays ${whereClause} GROUP BY tier ORDER BY count DESC;`)
    .all(params) as { tier: string; count: number }[];

  const topFielders = db
    .prepare(
      `SELECT fielder_name, COUNT(*) as count FROM plays ${whereClause} GROUP BY fielder_name ORDER BY count DESC LIMIT 10;`,
    )
    .all(params) as { fielder_name: string; count: number }[];

  const playsByTeam = db
    .prepare(
      `SELECT team, COUNT(*) as count FROM (
        SELECT away_team as team FROM plays ${whereClause}
        UNION ALL
        SELECT home_team as team FROM plays ${whereClause}
      ) GROUP BY team ORDER BY count DESC;`,
    )
    .all(params) as { team: string; count: number }[];

  return {
    totalByTier,
    topFielders: topFielders.map((r) => ({ fielderName: r.fielder_name, count: r.count })),
    playsByTeam,
  };
}

/**
 * A play that is eligible for a Savant video backfill attempt.
 *
 * Returned by queryBackfillCandidates as one record per unique
 * (game_pk, play_index, play_id) tuple — runner-row duplicates are collapsed.
 */
export interface BackfillCandidate {
  gamePk: number;
  playIndex: number;
  playId: string;
  date: string;
}

/**
 * Returns plays that are eligible for a Savant video backfill attempt.
 *
 * A row is eligible when:
 *   - video_url is NULL (we don't already have a video)
 *   - play_id is NOT NULL (we have a playId to query Savant with)
 *   - date falls within the configurable window (default last 2 days)
 *   - fetch_status is not in a terminal state ('success', 'no_video_found')
 *
 * DISTINCT collapses (game_pk, play_index, play_id) tuples so the caller
 * makes one Savant request per play even when multiple runner rows share it.
 *
 * @param db - An open Database instance.
 * @param windowDays - Inclusive age in days. Defaults to 2 (the daemon's
 *                     normal coverage window). The historical CLI passes
 *                     a very large value to disable the age cutoff.
 */
export function queryBackfillCandidates(
  db: Database,
  windowDays = 2,
): BackfillCandidate[] {
  // bun:sqlite parameter binding doesn't accept variables in date modifier
  // strings, so windowDays is interpolated into the SQL literal. windowDays
  // is a number from config; not user-supplied.
  const sql = `
    SELECT DISTINCT game_pk, play_index, play_id, date
    FROM plays
    WHERE video_url IS NULL
      AND play_id IS NOT NULL
      AND date >= date('now', '-${windowDays} days')
      AND (fetch_status IS NULL OR fetch_status NOT IN ('success', 'no_video_found'))
    ORDER BY date DESC, game_pk, play_index;
  `;

  const rows = db.prepare(sql).all() as {
    game_pk: number;
    play_index: number;
    play_id: string;
    date: string;
  }[];

  return rows.map((r) => ({
    gamePk: r.game_pk,
    playIndex: r.play_index,
    playId: r.play_id,
    date: r.date,
  }));
}

/**
 * Sets video_url, video_title, and fetch_status='success' for all rows
 * with the given (game_pk, play_index). Multiple runner rows for the same
 * play are updated in a single statement.
 *
 * @returns Number of rows updated.
 */
export function updatePlayVideoByPlayKey(
  db: Database,
  gamePk: number,
  playIndex: number,
  videoUrl: string,
  videoTitle: string,
): number {
  const stmt = db.prepare(`
    UPDATE plays
    SET video_url = $videoUrl,
        video_title = $videoTitle,
        fetch_status = 'success'
    WHERE game_pk = $gamePk AND play_index = $playIndex;
  `);
  const result = stmt.run({
    $videoUrl: videoUrl,
    $videoTitle: videoTitle,
    $gamePk: gamePk,
    $playIndex: playIndex,
  });
  return Number(result.changes);
}

/**
 * Sets fetch_status for all rows with the given (game_pk, play_index)
 * without touching video_url. Used when a Savant probe failed or returned
 * no video, so the next cycle can decide whether to retry.
 *
 * @returns Number of rows updated.
 */
export function updatePlayFetchStatus(
  db: Database,
  gamePk: number,
  playIndex: number,
  status: FetchStatus,
): number {
  const stmt = db.prepare(`
    UPDATE plays
    SET fetch_status = $status
    WHERE game_pk = $gamePk AND play_index = $playIndex;
  `);
  const result = stmt.run({
    $status: status,
    $gamePk: gamePk,
    $playIndex: playIndex,
  });
  return Number(result.changes);
}

/**
 * Populates play_id for legacy rows (game_pk, play_index) that don't have
 * one yet. Idempotent: rows where play_id is already set are not modified.
 *
 * @returns Number of rows updated.
 */
export function updatePlayId(
  db: Database,
  gamePk: number,
  playIndex: number,
  playId: string,
): number {
  const stmt = db.prepare(`
    UPDATE plays
    SET play_id = $playId
    WHERE game_pk = $gamePk AND play_index = $playIndex AND play_id IS NULL;
  `);
  const result = stmt.run({
    $playId: playId,
    $gamePk: gamePk,
    $playIndex: playIndex,
  });
  return Number(result.changes);
}

/**
 * Database-level metadata: total rows, file size, date range.
 */
export function getDbStats(db: Database, dbPath: string): DbStats {
  const totalRow = db.prepare("SELECT COUNT(*) as count FROM plays;").get() as { count: number };
  const minRow = db.prepare("SELECT MIN(date) as val FROM plays;").get() as { val: string | null };
  const maxRow = db.prepare("SELECT MAX(date) as val FROM plays;").get() as { val: string | null };

  let dbSizeBytes = 0;
  if (dbPath !== ":memory:") {
    dbSizeBytes = Bun.file(dbPath).size;
  }

  return {
    totalPlays: totalRow.count,
    dbSizeBytes,
    oldestPlay: minRow.val,
    newestPlay: maxRow.val,
  };
}
