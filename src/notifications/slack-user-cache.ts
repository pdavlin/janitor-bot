/**
 * In-process TTL cache wrapping `users.info`.
 *
 * Reaction events arrive in bursts and we need to know whether the reactor
 * is a bot or restricted user before counting their vote. Hitting the Slack
 * API on every reaction would burn rate limit fast, so we cache the lookup
 * for ten minutes per user_id.
 *
 * Cache is in-memory only; bot restart clears it. That's fine — first
 * reaction after restart pays the API call, subsequent ones reuse it.
 */

import type { Logger } from "../logger";
import { callSlackApi, type SlackClientConfig } from "./slack-client";

/** Subset of `users.info` fields we care about. */
export interface UserInfo {
  isBot: boolean;
  isRestricted: boolean;
  /** Includes both `is_restricted` (multi-channel guest) and `is_ultra_restricted`. */
  isGuest: boolean;
}

/** Cache TTL for a single user's info. */
const TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  info: UserInfo;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Returns the cached info for a user, or fetches it via `users.info` and
 * caches the result. Returns null when the bot token is missing or the API
 * call fails so the caller can fail-closed (skip the vote).
 */
export async function getUserInfo(
  config: SlackClientConfig,
  userId: string,
  logger: Logger,
): Promise<UserInfo | null> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  if (!config.botToken) return null;

  const result = await callSlackApi<{
    user: {
      is_bot: boolean;
      is_restricted: boolean;
      is_ultra_restricted: boolean;
    };
  }>("users.info", { user: userId }, config.botToken, logger);

  if (!result) return null;

  const info: UserInfo = {
    isBot: result.user.is_bot,
    isRestricted: result.user.is_restricted,
    isGuest: result.user.is_restricted || result.user.is_ultra_restricted,
  };
  cache.set(userId, { info, expiresAt: Date.now() + TTL_MS });
  return info;
}

/**
 * Decision rule: a reactor's vote counts when they are a real, full-channel
 * member. Bots and guests (single- or multi-channel) are excluded.
 */
export function isVotingEligible(info: UserInfo | null): boolean {
  if (!info) return false;
  return !info.isBot && !info.isGuest;
}

/** Empties the cache. Test helper. */
export function clearUserCache(): void {
  cache.clear();
}
