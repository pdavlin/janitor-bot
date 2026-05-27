# rematch-agent Contract

**Created**: 2026-05-27
**Confidence Score**: 96/100
**Status**: Draft

## Problem Statement

The janitor-bot weekly review attaches a Baseball Savant video to each outfield-assist finding. The current matcher is a cheap, single-pass heuristic against the game's video description list. This week saw an uptick in obviously wrong attachments — the video on the card is not the play described in the finding. There is no path for a viewer to correct it short of editing the Slack message by hand or shipping a code change to the heuristic.

The audience is small (three Slack members, all engaged with the digest) and trusts the bot's output enough to act on it. Wrong videos erode that trust quickly, and the cost of fixing one by hand is high relative to the cost of the bot retrying with more context.

If unsolved: viewers continue to see wrong videos with no recourse; the team either tolerates the noise, manually edits, or makes the heuristic more expensive on every play to reduce a small percentage of misses.

## Goals

1. Any Slack member in the channel can trigger a re-match by reacting with `:repeat:` (🔁) on a per-play Slack message (the daily game-header flow's play post — the one that actually carries the video link).
2. A re-match runs the existing Anthropic tool-use agent (the one introduced for weekly-review in commit 40ad013) against the game's full video-description list and returns a chosen video.
3. The first-pass heuristic remains the default; the agent only runs on demand, so total LLM cost scales with disagreement, not with finding volume.
4. The play's Slack message is edited in place to swap the video link, `plays.video_url` / `plays.video_title` are updated in SQLite, and a thread reply records the swap so the change is auditable.
5. Every attempt is appended to a new sibling event log (`play_rematch_events`) that mirrors the existing reaction-event pattern. The existing `finding_resolution_events` table is not modified — it stays finding-scoped.

## Success Criteria

- [ ] Reacting `:repeat:` on a per-play Slack message triggers exactly one agent invocation (per distinct displayed video) and edits the play message if the agent returns a different video.
- [ ] If the agent returns the same video that is currently shown, the play message is left untouched and a thread reply states the agent agreed with the first pass.
- [ ] A second `:repeat:` reaction on the same play, while the displayed video has not changed since the last attempt, is ignored (deduped). Once the displayed video changes (via successful re-match), the play is eligible for one more attempt.
- [ ] Plays whose first pass produced no video at all are also eligible for re-match; the agent receives the full game video list and may insert a video.
- [ ] Every re-match attempt — agreed, swapped, no_match, or deduped — appends a row to `play_rematch_events` with: game_pk, play_index, user_id, prior_video_url (nullable), new_video_url (nullable), decision, agent_reason (nullable), event_ts.
- [ ] Unit tests cover: dedupe by displayed video, agent-agreed thread reply, agent-swapped edit + thread reply, no-video-on-first-pass path, malformed agent response handling.
- [ ] No regression in existing reaction handlers — `:repeat:` is disjoint from `:fire:` / `:wastebasket:` (play votes) and `:white_check_mark:` / `:x:` (finding resolution).

## Scope Boundaries

### In Scope

- Pre-seed the `:repeat:` reaction on every fresh per-play message so users can re-match with a single tap, matching the existing fire/wastebasket seed behavior.
- New Slack reaction routing branch for `:repeat:` on per-play messages, alongside the existing fire/wastebasket vote routing.
- Re-match invocation reuses the Anthropic tool-use agent and SDK pattern already in the project (Sonnet 4.6, tool-use loop in `src/cli/weekly-review/agent.ts`).
- Agent input: the play's description plus the full list of video descriptions for that game (refetched from the MLB content API or, if cached, the same shape used by `matchVideoToPlay`).
- Slack message edit (swap video link via `chat.update` block-kit) and thread reply breadcrumb on successful swap; thread-only reply on agent-agreed; silent log entry on no_match; silent log entry on deduped.
- One re-match per distinct displayed `plays.video_url`, including the no-video (`NULL`) baseline.
- New `play_rematch_events` SQLite table + indexes; new migration.

### Out of Scope

- Other digests: HR digest (now abandoned per current branch decision) is untouched.
- Weekly-review finding thread replies: those are plain text today and contain no video link, so `:repeat:` on them is a no-op.
- Cross-game search: the agent never considers videos from games other than the play's game.
- Modifying the existing `finding_resolution_events` schema.
- Authority/permissions: any channel member can trigger; no allowlist.
- Re-running the heuristic itself or making it smarter — that is a separate problem.
- Reacting to swap to a manually specified video; the agent picks.

### Future Considerations

- Aggregated accuracy metrics from the resolution log (how often the agent disagreed, how often the swap stuck) — useful but not part of this delivery.
- A `:no_entry_sign:` reaction to mark a play as un-matchable (agent and heuristic both wrong).
- Extending the same pattern to per-finding thread reply video links if those grow video attachments.
- Surfacing the agent's reasoning in the thread reply (currently only the result lands there).

---

*This contract was generated from brain dump input. Review and approve before proceeding to PRD generation.*
