# PRD: rematch-agent - Phase 2

**Contract**: ./contract.md
**Phase**: 2 of 2
**Focus**: Slack reaction wiring — `:repeat:` handler on per-play messages, dedupe, message edit, thread reply, new `play_rematch_events` log table.

## Phase Overview

Phase 2 connects the Phase 1 agent to the live daily per-play Slack flow. A `:repeat:` (🔁) reaction on a per-play message (the one carrying the video link) triggers a re-match, dedupes against the currently displayed `plays.video_url`, edits the play message on a successful swap, posts a thread reply on every outcome except dedupe drops, updates the `plays` row, and appends a row to the new `play_rematch_events` table.

This phase ships the user-visible feature. Phase 1's function is invoked via injection or direct import; in tests it is mocked. Anthropic calls are the only paid surface, and the dedupe rule (one attempt per distinct displayed `video_url`) is the cost cap.

Value after this phase: any channel member can correct a wrong video by adding a single emoji.

## User Stories

1. As a channel member reading the weekly review, I want to react `:repeat:` on a finding whose video is wrong and have the bot try again, so I do not have to file an issue or wait for a code change.
2. As a channel member, I want a clear signal in the thread when the bot has tried — whether it swapped, agreed, or could not find a better match — so I know the reaction was received.
3. As the operator, I want repeated `:repeat:` reactions on the same unchanged message to be ignored, so a curious user clicking the same emoji twice does not bill us twice.
4. As the operator, I want every re-match attempt logged to the resolution log so I can later compare agent vs. heuristic accuracy.

## Functional Requirements

### Reaction Handling

- **FR-2.0**: Extend the existing per-play seed step (`seedVoteReactions` in `slack-client.ts`) to also seed `:repeat:` on every fresh play message. The bot's own seed must not trigger a re-match — the existing `isVotingEligible` (is_bot=false) filter in the dispatcher applies the same way it does for vote tallying.
- **FR-2.1**: Add a third reaction-routing branch in `slack-events.ts#handleReactionEvent` that fires when the reaction name is `repeat` (Slack shortcode for 🔁). Existing fire/wastebasket and white_check_mark/x branches are unchanged.
- **FR-2.2**: When `:repeat:` lands, call `lookupPlayMessageByTs` to resolve `(game_pk, play_index)`. If no row, ignore.
- **FR-2.3**: Resolve the play row from `plays` to get `video_url`, `video_title`, `description`, `fielderId`. Fetch the game's full video candidate list (re-use the existing MLB content fetcher; spec confirms whether to call live or cache).
- **FR-2.4**: Read the most recent `play_rematch_events` row for `(game_pk, play_index)`. If its `prior_video_url` equals the current `plays.video_url` (treating both NULL as equal), drop the reaction silently — insert a `decision = 'deduped'` row and return. No agent call.
- **FR-2.5**: Otherwise, invoke `rematchVideo` from Phase 1 with `{ playDescription, currentVideoId: current playback id derived from video_url, candidates: full game video list, gamePk }`.

### Slack Effects

- **FR-2.6**: On `decision === 'swapped'`: re-render the play message blocks with the new video URL/title, call `chat.update` against `(channel, ts)`. Post a thread reply: "Re-matched video at @user's request — swapped to `<new title>`." Exact wording finalized in spec.
- **FR-2.7**: On `decision === 'agreed'`: do not edit the play message. Post a thread reply: "Agent reviewed at @user's request and agreed with the current video." Exact wording finalized in spec.
- **FR-2.8**: On `decision === 'no_match'`: do not edit the play message. Post a thread reply: "Agent could not identify a better video at @user's request." Do not silently fail.
- **FR-2.9**: If the play message originally had no video link, a successful swap re-renders the blocks with the link inserted in the standard spot (`slack-formatter.ts` line ~161 layout).

### Persistence

- **FR-2.10**: Create new table `play_rematch_events` in `src/storage/db.ts` with columns: `id` (PK auto), `game_pk` INT, `play_index` INT, `user_id` TEXT, `prior_video_url` TEXT NULL, `new_video_url` TEXT NULL, `decision` TEXT CHECK IN (`swapped`, `agreed`, `no_match`, `deduped`), `agent_reason` TEXT NULL, `event_ts` TEXT, `received_at` TEXT DEFAULT now. Add index on `(game_pk, play_index, id DESC)`.
- **FR-2.11**: On `decision === 'swapped'`, update `plays.video_url` and `plays.video_title` to the new values within the same transaction as the event-log row, so subsequent dedupe checks see the new state.

### Failure Modes

- **FR-2.12**: If `rematchVideo` throws (network error, API timeout, etc.), post a thread reply: "Re-match request from @user failed — see logs." Log the error. Do not retry automatically. Do not block on the reaction handler.
- **FR-2.13**: If the Slack `chat.update` for the parent edit fails after a successful agent swap, still record the swap in the resolution log and still post the thread reply (with an inline note that the edit failed).

## Non-Functional Requirements

- **NFR-2.1**: Handler must acknowledge Slack's `reaction_added` event within Slack's 3-second window. The agent call runs async after ack.
- **NFR-2.2**: A single re-match end-to-end (reaction → thread reply) completes in under 20 seconds at p95.
- **NFR-2.3**: All re-match logic gated behind a config flag (e.g., `REMATCH_AGENT_ENABLED`), so the feature can be killed without redeploying if it misbehaves in prod.
- **NFR-2.4**: No new secrets; reuse Slack tokens already in env.

## Dependencies

### Prerequisites

- Phase 1 complete (`rematchVideo` function with stable signature).
- Existing weekly-review Slack handler infra (reaction routing exists for confirm/reject).
- Existing reaction-resolution log table from commit 3060e6f.

### Outputs for Next Phase

- N/A — this is the final phase.

## Acceptance Criteria

- [ ] Adding a `:repeat:` reaction in the weekly-review channel against a known finding triggers a re-match attempt and produces a thread reply (manual test against prod, per the project's no-staging-channel convention).
- [ ] Re-adding `:repeat:` on the same message after a swap (with the displayed video now updated) triggers another attempt.
- [ ] Re-adding `:repeat:` on the same message when the displayed video has not changed is silently deduped (no thread reply, no agent call, one log row with `decision: 'deduped'`).
- [ ] A finding whose first pass attached no video is eligible for re-match; the agent receives the full candidate list and may insert a video link.
- [ ] The `:repeat:` emoji does not collide with the existing confirm/reject reactions in the routing table.
- [ ] Unit tests cover: reaction routing happy path, dedupe drop, agent throws, Slack edit fails after agent success, no-current-video branch.
- [ ] Integration test exists where the reaction handler is invoked with a fake Slack event and `rematchVideo` is mocked to each of the three outcomes; assert correct Slack calls and log rows.
- [ ] Type-check and full project test suite pass.
- [ ] The `REMATCH_AGENT_ENABLED` config flag controls whether the handler is registered.

## Open Questions

- Should we mention the agent's `reason` in the thread reply, or keep replies terse and put the reason in the log only? **Default: log only.** Revisit if reasons would obviously help users.
- Removing a `:repeat:` reaction (`reaction_removed`) — should we treat it as anything? **Default: ignore.** Re-match is a one-way request.
- Is there value in surfacing the dedupe drop to the reacting user? **Default: no.** Silent log keeps the channel quiet.

---

*Review this PRD and provide feedback before spec generation.*
