/**
 * CLI: prints the queue of plays whose snapshot is flagged for tier review.
 *
 * A play is flagged when the channel's vote tally disagrees with the bot's
 * detected tier (see snapshot-job.ts for the rule). The operator runs this
 * CLI to surface the queue and decide whether the detection logic needs a
 * tweak.
 *
 * Usage:
 *   bun run tier-review
 *
 * Environment:
 *   DB_PATH - path to SQLite database (default: ./janitor-throws.db)
 */

import { createDatabase } from "../storage/db";
import { loadConfig } from "../config";

interface FlaggedRow {
  game_pk: number;
  play_index: number;
  date: string;
  away_team: string;
  home_team: string;
  fielder_name: string;
  fielder_position: string;
  target_base: string;
  tier: string;
  description: string;
  fire_count: number;
  trash_count: number;
  net_score: number;
  voter_count: number;
  tier_review_reason: string | null;
  snapshotted_at: string;
}

interface TierDisputeTagRow {
  tag_value: string;
  matched_text: string;
  comment_user_id: string;
  received_at: string;
}

const config = loadConfig();
const db = createDatabase(config.dbPath);

const rows = db.prepare(`
  SELECT
    p.game_pk, p.play_index, p.date, p.away_team, p.home_team,
    p.fielder_name, p.fielder_position, p.target_base, p.tier,
    p.description,
    vs.fire_count, vs.trash_count, vs.net_score, vs.voter_count,
    vs.tier_review_reason, vs.snapshotted_at
  FROM vote_snapshots vs
  JOIN plays p ON p.game_pk = vs.game_pk AND p.play_index = vs.play_index
  WHERE vs.tier_review_flagged = 1
  GROUP BY vs.game_pk, vs.play_index
  ORDER BY vs.snapshotted_at DESC
  LIMIT 50;
`).all() as FlaggedRow[];

if (rows.length === 0) {
  console.log("No plays flagged for tier review.");
  process.exit(0);
}

const tagStmt = db.prepare(`
  SELECT tag_value, matched_text, comment_user_id, received_at
  FROM play_tags
  WHERE tag_type = 'tier_dispute'
    AND game_pk = $gamePk
    AND (play_index = $playIndex OR play_index IS NULL)
  ORDER BY received_at ASC;
`);

for (const r of rows) {
  console.log(`${r.date} ${r.away_team} @ ${r.home_team}`);
  console.log(`  ${r.fielder_name} (${r.fielder_position}) -> ${r.target_base}`);
  console.log(
    `  detected: ${r.tier} | fire ${r.fire_count} | trash ${r.trash_count} | net ${r.net_score} | voters ${r.voter_count}`,
  );
  console.log(`  reason: ${r.tier_review_reason}`);
  console.log(`  ${r.description}`);

  const tags = tagStmt.all({
    $gamePk: r.game_pk,
    $playIndex: r.play_index,
  }) as TierDisputeTagRow[];
  if (tags.length > 0) {
    console.log(`  tier-dispute tags:`);
    for (const t of tags) {
      console.log(
        `    - ${t.tag_value} ("${t.matched_text}") by ${t.comment_user_id} at ${t.received_at}`,
      );
    }
  }
  console.log("");
}

db.close();
