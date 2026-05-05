/**
 * CLI: prints recent operator-reported video issues parsed from Slack
 * thread replies.
 *
 * Each row is one keyword-matched tag joined to the play it was attributed
 * to. Tags attributed at the game level (no fielder mention or ambiguous
 * mention) show no play-specific fields.
 *
 * Usage:
 *   bun run video-issues
 *
 * Environment:
 *   DB_PATH - path to SQLite database (default: ./janitor-throws.db)
 */

import { createDatabase } from "../storage/db";
import { loadConfig } from "../config";

interface VideoIssueRow {
  id: number;
  game_pk: number;
  play_index: number | null;
  tag_value: string;
  matched_text: string;
  comment_ts: string;
  comment_user_id: string;
  received_at: string;
  fielder_name: string | null;
  fielder_position: string | null;
  target_base: string | null;
  video_url: string | null;
  date: string | null;
  away_team: string | null;
  home_team: string | null;
}

const config = loadConfig();
const db = createDatabase(config.dbPath);

const rows = db.prepare(`
  SELECT
    pt.id, pt.game_pk, pt.play_index, pt.tag_value, pt.matched_text,
    pt.comment_ts, pt.comment_user_id, pt.received_at,
    p.fielder_name, p.fielder_position, p.target_base, p.video_url, p.date,
    p.away_team, p.home_team
  FROM play_tags pt
  LEFT JOIN plays p ON p.game_pk = pt.game_pk AND p.play_index = pt.play_index
  WHERE pt.tag_type = 'video_issue'
  ORDER BY pt.received_at DESC
  LIMIT 100;
`).all() as VideoIssueRow[];

if (rows.length === 0) {
  console.log("No video issues reported.");
  process.exit(0);
}

for (const r of rows) {
  const matchup = r.date && r.away_team && r.home_team
    ? `${r.date} ${r.away_team} @ ${r.home_team}`
    : `game ${r.game_pk}`;
  console.log(`${matchup}`);

  if (r.play_index === null) {
    console.log(`  scope: game-level (no fielder mention)`);
  } else if (r.fielder_name) {
    console.log(`  ${r.fielder_name} (${r.fielder_position}) -> ${r.target_base}`);
  } else {
    console.log(`  play_index ${r.play_index} (play not found)`);
  }

  console.log(`  tag: ${r.tag_value} ("${r.matched_text}")`);
  console.log(`  by ${r.comment_user_id} at ${r.received_at}`);
  if (r.video_url) console.log(`  video: ${r.video_url}`);
  console.log("");
}

db.close();
