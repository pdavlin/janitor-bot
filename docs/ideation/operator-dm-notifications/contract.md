# Contract: operator-dm-notifications

## Problem

Janitor-bot writes operator-relevant artifacts and events to its prod
host (and to logs no one tails) where they go unseen. Specifically:

- Weekly-review run dumps land in `~/janitor-bot/weekly-review-dumps/`
  on the prod VM. The operator only discovers them by ssh-ing in.
- A second concurrent `weekly-review` invocation aborts with a
  stderr message that goes to journald and disappears.
- A retention-sweep failure logs at warn level and the run continues
  silently — the operator finds out (if at all) by grepping logs.
- A run where every LLM finding fails description validation produces
  the "LLM findings withheld" Slack post but no per-failure context.

The operator is a single person in a 3-member Slack workspace; channel
posts are visible but easy to miss in a busy thread. Without a direct
nudge, prod-side signal rots.

## Goals

1. Establish a generic `notifyOperator(message, context?)` helper that
   sends a Slack DM to a configured operator user_id.
2. Wire four specific events to operator DMs:
   - **Full-run dump captured** — when `bun run weekly-review` (the
     full-run path) writes a `--dump` file. Includes a finding
     summary and the dump path.
   - **Concurrent run blocked** — when a second `weekly-review`
     invocation hits the per-week lock.
   - **Retention sweep failed** — when the post-run sweep throws.
   - **All-rejected validation** — when every LLM finding fails the
     description rules and the digest falls back to baseline-only.
3. Keep the existing channel digest post unchanged. The DM is
   additive, not a replacement.

## Success

- The operator receives a Slack DM within seconds of each of the four
  trigger events firing on prod.
- Each DM contains enough context to decide whether to ssh in or
  ignore (event type, brief summary, relevant identifiers like run id
  / week / dump path).
- DMs contain no transcript content. The validated finding summaries
  are already abstract per the existing description rules.
- Configuration is a single env var (`OPERATOR_USER_ID`); when unset,
  notifications are no-op'd with a single startup warn.
- A DM-send failure does not break the underlying run.

## Scope

### In scope

- Generic `notifyOperator(slackConfig, userId, message, logger)` helper.
- Four event trigger sites in the weekly-review flow.
- One env var (`OPERATOR_USER_ID`) read by `loadConfig`.
- Best-effort delivery: log warn on failure, continue.
- Slack DMs use `chat.postMessage` with the operator's user_id as the
  `channel` parameter (no new scope expected; current `chat:write`
  covers it). Verified during implementation.
- Unit tests for the helper and each trigger-site wire-up.

### Explicitly out of scope

- Mirroring the weekly digest itself into the operator's DMs. Channel
  post stays the source of truth.
- Notifications from the daemon (game-detection, backfill, snapshot
  loops). Their existing logging is sufficient.
- Email, push, or other transports. Slack DM only.
- Operator-discoverable lookup (e.g. `users.lookupByEmail`). Operator
  user_id is configured statically.
- Mark-the-run-as-error or post-to-channel fallback when DM fails.
  Best-effort only.
- Replay-prompt notifications. The replay tool is operator-driven and
  prints to stdout; no DM needed.

## Constraints

- Bot's existing Slack scopes (`chat:write`) are expected to cover DM
  posts. If the deploy reveals a missing scope, surface the error and
  document the fix; do not block on speculative scope additions.
- Same privacy posture as the existing channel post: validated
  findings only, no transcripts, no quote characters in DM body.
- Failures of the DM call must not affect lock release, run status,
  or exit code.
- The configured `OPERATOR_USER_ID` is sensitive (workspace-internal);
  treat it like a token at deploy time.

## Discussion log

- **Trigger condition** — Full runs only. Dry-runs are operator-
  driven and already print to stdout. (Decided.)
- **Helper shape** — Generic, not dump-specific. The dump
  notification is the first caller; the helper signature accommodates
  the other three trigger sites without modification. (Decided.)
- **Other events** — Concurrent-run blocked, retention-sweep failed,
  all-rejected validation. Weekly-digest mirror NOT included.
  (Decided.)
- **DM failure mode** — Log warn, continue. Same posture as the
  existing `seedVoteReactions` failure handling. (Decided.)
- **Operator user_id storage** — Env var `OPERATOR_USER_ID`. When
  unset, the helper is a no-op and emits one startup warn. No runtime
  lookup. (Decided by default; flag if you want fallback behavior.)
