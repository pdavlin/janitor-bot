import type { Database } from "bun:sqlite";

export interface ThreadMessageCountResult {
  gamePk: number;
  messageCount: number;
}

/**
 * Returns the count of recorded play replies for a game thread.
 *
 * This is an approximation of the channel-thread message count: we
 * count rows in `slack_play_messages` (the bot's own per-play replies)
 * rather than calling `conversations.replies` live. Reasoning: the
 * live call would push us against the cost cap and add latency. The
 * bot posts one reply per play, so the row count is a reasonable
 * lower bound on thread depth.
 */
export function getThreadMessageCount(
  db: Database,
  gamePk: number,
): ThreadMessageCountResult {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM slack_play_messages WHERE game_pk = $gamePk;`,
    )
    .get({ $gamePk: gamePk }) as { c: number };
  return { gamePk, messageCount: row.c };
}
