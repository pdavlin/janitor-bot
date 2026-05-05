/**
 * Deterministic SQL aggregations for the weekly digest.
 *
 * Five fixed queries against `vote_snapshots` joined to `plays`,
 * scoped to the target week. The result is rendered as compact mrkdwn
 * for the Slack post and is what the LLM is graded against.
 */

import type { Database } from "bun:sqlite";
import type { Tier } from "../../types/play";
import type { WeekWindow } from "./week-window";

export interface BaselineTopPlay {
  playId: number;
  netScore: number;
  description: string;
}

export interface BaselineByTier {
  tier: Tier;
  fireTotal: number;
  trashTotal: number;
}

export interface BaselineByPositionRunners {
  position: string;
  runnersOn: string;
  fire: number;
  trash: number;
}

export interface Baseline {
  totalPlays: number;
  playsWithVotes: number;
  flaggedCount: number;
  topPositive: BaselineTopPlay[];
  topNegative: BaselineTopPlay[];
  byTier: BaselineByTier[];
  byPositionRunners: BaselineByPositionRunners[];
}

/**
 * Computes the baseline aggregations for a week window. All queries are
 * parameterized; the window's `weekStarting`/`weekEnding` strings are
 * inclusive YYYY-MM-DD.
 */
export function computeBaseline(db: Database, window: WeekWindow): Baseline {
  const params = { $from: window.weekStarting, $to: window.weekEnding };

  const totals = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total_plays,
        SUM(CASE WHEN s.voter_count > 0 THEN 1 ELSE 0 END) AS plays_with_votes,
        SUM(CASE WHEN s.tier_review_flagged = 1 THEN 1 ELSE 0 END) AS flagged
      FROM plays p
      LEFT JOIN vote_snapshots s ON s.game_pk = p.game_pk AND s.play_index = p.play_index
      WHERE p.date BETWEEN $from AND $to;
    `,
    )
    .get(params) as {
    total_plays: number | null;
    plays_with_votes: number | null;
    flagged: number | null;
  };

  const topPositive = db
    .prepare(
      `
      SELECT p.id AS play_id, s.net_score AS net_score, p.description AS description
      FROM plays p
      JOIN vote_snapshots s ON s.game_pk = p.game_pk AND s.play_index = p.play_index
      WHERE p.date BETWEEN $from AND $to AND s.net_score > 0
      ORDER BY s.net_score DESC, p.id ASC
      LIMIT 5;
    `,
    )
    .all(params) as { play_id: number; net_score: number; description: string }[];

  const topNegative = db
    .prepare(
      `
      SELECT p.id AS play_id, s.net_score AS net_score, p.description AS description
      FROM plays p
      JOIN vote_snapshots s ON s.game_pk = p.game_pk AND s.play_index = p.play_index
      WHERE p.date BETWEEN $from AND $to AND s.net_score < 0
      ORDER BY s.net_score ASC, p.id ASC
      LIMIT 5;
    `,
    )
    .all(params) as { play_id: number; net_score: number; description: string }[];

  const byTierRows = db
    .prepare(
      `
      SELECT p.tier AS tier,
             COALESCE(SUM(s.fire_count), 0) AS fire_total,
             COALESCE(SUM(s.trash_count), 0) AS trash_total
      FROM plays p
      LEFT JOIN vote_snapshots s ON s.game_pk = p.game_pk AND s.play_index = p.play_index
      WHERE p.date BETWEEN $from AND $to
      GROUP BY p.tier
      ORDER BY CASE p.tier WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END;
    `,
    )
    .all(params) as { tier: Tier; fire_total: number; trash_total: number }[];

  const byTier: BaselineByTier[] = byTierRows.map((r) => ({
    tier: r.tier,
    fireTotal: r.fire_total,
    trashTotal: r.trash_total,
  }));

  const byPositionRunners = db
    .prepare(
      `
      SELECT p.fielder_position AS position, p.runners_on AS runners_on,
             COALESCE(SUM(s.fire_count), 0) AS fire,
             COALESCE(SUM(s.trash_count), 0) AS trash
      FROM plays p
      LEFT JOIN vote_snapshots s ON s.game_pk = p.game_pk AND s.play_index = p.play_index
      WHERE p.date BETWEEN $from AND $to
      GROUP BY p.fielder_position, p.runners_on
      HAVING (COALESCE(SUM(s.fire_count), 0) + COALESCE(SUM(s.trash_count), 0)) > 0
      ORDER BY (COALESCE(SUM(s.fire_count), 0) + COALESCE(SUM(s.trash_count), 0)) DESC,
               p.fielder_position ASC, p.runners_on ASC
      LIMIT 5;
    `,
    )
    .all(params) as {
    position: string;
    runners_on: string;
    fire: number;
    trash: number;
  }[];

  return {
    totalPlays: totals.total_plays ?? 0,
    playsWithVotes: totals.plays_with_votes ?? 0,
    flaggedCount: totals.flagged ?? 0,
    topPositive: topPositive.map((r) => ({
      playId: r.play_id,
      netScore: r.net_score,
      description: r.description,
    })),
    topNegative: topNegative.map((r) => ({
      playId: r.play_id,
      netScore: r.net_score,
      description: r.description,
    })),
    byTier,
    byPositionRunners: byPositionRunners.map((r) => ({
      position: r.position,
      runnersOn: r.runners_on,
      fire: r.fire,
      trash: r.trash,
    })),
  };
}

/**
 * Renders the baseline as compact mrkdwn for the Slack digest. Empty
 * sections are elided so the post stays scannable.
 */
export function renderBaselineForSlack(b: Baseline): string {
  const lines: string[] = [];
  lines.push(
    `Baseline: ${b.totalPlays} plays · ${b.playsWithVotes} with votes · ${b.flaggedCount} flagged`,
  );

  if (b.byTier.length > 0) {
    const tierBits = b.byTier.map(
      (t) => `${t.tier}: 🔥${t.fireTotal}/🗑${t.trashTotal}`,
    );
    lines.push(`By tier — ${tierBits.join(" · ")}`);
  }

  if (b.byPositionRunners.length > 0) {
    const pieces = b.byPositionRunners.map((r) => {
      const runners = r.runnersOn === "" ? "bases empty" : r.runnersOn;
      return `${r.position}/${runners}: 🔥${r.fire}/🗑${r.trash}`;
    });
    lines.push(`By position × runners — ${pieces.join(" · ")}`);
  }

  if (b.topPositive.length > 0) {
    const top = b.topPositive[0];
    lines.push(`Top positive: play #${top.playId} (+${top.netScore})`);
  }

  if (b.topNegative.length > 0) {
    const bot = b.topNegative[0];
    lines.push(`Top negative: play #${bot.playId} (${bot.netScore})`);
  }

  return lines.join("\n");
}
