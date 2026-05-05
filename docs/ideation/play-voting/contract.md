# play-voting Contract

**Created**: 2026-05-01
**Confidence Score**: 98/100
**Status**: Approved

## Problem Statement

The janitor-bot posts detected outfield assist plays into a 3-person Slack channel, classified into high/medium/low tiers by hand-tuned rules in `src/detection/ranking.ts`. Misclassifications go unobserved, and there is no record of which detected plays were actually memorable to the channel. The data being captured today is what the bot thinks happened, with no human-in-the-loop signal layered on top.

Three reviewers in the channel are willing to vote on plays. Their votes can simultaneously serve three downstream uses: validating the tier classifier (labeled feedback), seeding a future "top plays" web UI (curation), and giving each reviewer a personal record of plays they flagged (taste log). With N=3, the "crowd" is small enough that consensus is high signal — what looks like a noisy crowdsource is actually a small panel of trusted reviewers.

If unsolved: tier rules drift without correction, no historical "best plays" archive accumulates, and the channel posts go by without engagement. The phase 2 web UI has nothing to render.

## Goals

1. Capture per-play vote signal from `:fire:` and `:wastebasket:` reactions on bot messages, written to DB within seconds of the reaction event.
2. Persist vote events (per user, per play, per direction) in a way that survives bot restarts and supports historical queries.
3. Snapshot vote counts 24 hours after the parent message is posted, locking the tally as a stable value for downstream consumers.
4. Mark plays for tier review when 2 of 3 voters contradict the detected tier in the snapshot.
5. Capture qualitative feedback from threaded comments by recognizing a small, fixed set of tag keywords (tier disputes, video issues) and linking them to plays in DB.
6. Lay a queryable data foundation that the phase 2 web UI can render top plays from, without committing to UI design now.

## Success Criteria

- [ ] Adding `:fire:` to a posted bot message increments a per-play vote tally in DB within 5 seconds of the Slack event.
- [ ] Removing a reaction decrements the tally; net counts always match user-visible reactions for plays still inside the 24h window.
- [ ] After 24 hours, a snapshot row exists for the message with final fire/trash counts per play and reactions added afterward do not change the snapshot.
- [ ] When 2+ of 3 voters trash a play with detected tier of `high` or `medium`, OR fire a play with detected tier of `low`, the play row is flagged for tier review with a reason field.
- [ ] The original Slack message tier emoji and labels never change as a result of votes.
- [ ] A thread reply containing a recognized tier dispute keyword (e.g. "should be high", "overrated") creates a tag row linked to the corresponding play.
- [ ] A thread reply containing a recognized video issue keyword (e.g. "wrong video", "video missing") creates a tag row of type `video_issue`.
- [ ] A SQL query against the votes/snapshots tables can return "top N plays by net score for date range X to Y" without scanning the events log.
- [ ] The Savant video backfill rescue flow continues to work — `chat.update` on the parent message does not lose vote state, and rescues posted as thread replies are not mis-parsed as comment tags.

## Scope Boundaries

### In Scope

- Slack Events API subscription for `reaction_added`, `reaction_removed`, and `message` events scoped to thread replies on bot-posted messages.
- HTTPS endpoint on the existing `Bun.serve()` server (`src/server/`) to receive Slack event callbacks, with signature verification.
- DB schema additions:
  - `votes` — append-only event log of (user_id, gamePk, playIndex, direction, ts, action) where action is added/removed.
  - `vote_snapshots` — locked tallies per (gamePk, playIndex) once the 24h window closes.
  - `play_tags` — extracted tag keywords from thread comments (gamePk, playIndex, tag_type, tag_text, comment_ts, user_id).
- **Message structure (locked)**: Each game posts as a parent header message (teams, count, date) followed by one thread reply per play. Reactions on a thread reply attribute to that single play. This replaces the current single-combined-message structure.
- Schema split: replace `slack_messages` (keyed by `game_pk`) with two tables — `slack_game_headers` (`game_pk` → `channel`, `ts`) and `slack_play_messages` (`game_pk`, `play_index` → `channel`, `ts`, `parent_ts`).
- Rescue flow update: `backfill-notifier.ts` targets the specific play's thread reply for `chat.update` instead of re-rendering the full game message. Per-game lock can scope down to per-play or be removed.
- Per-play voting only activates in bot-token mode. Webhook fallback degrades to a single combined message with no voting support (preserves current behavior).
- Snapshot job triggered 24h after `posted_at` (driven from the existing scheduler in `src/daemon/scheduler.ts`).
- Tag keyword parser with a fixed, case-insensitive keyword list for two categories: tier disputes and video issues.
- Idempotent handling of Slack event retries (Slack retries up to 3x on non-2xx).

### Out of Scope

- **Web UI for top plays** — the user's stated phase 2 goal but not yet designed. Phase 1 builds the data shape it would consume; phase 2 designs the UI.
- **Daily digest message in Slack** — explicitly not selected as an on-close action. Skipped to keep channel signal-to-noise high.
- **Auto re-tiering of plays** — votes are labels for offline review, never source of truth for the displayed tier. Explicitly chosen over auto-adjust.
- **Free-form NLP / LLM analysis on comments** — only fixed keyword matching in phase 1.
- **Voter authentication or allowlisting** — N=3, all trusted. No vote weighting, no role checks.
- **Free hashtag capture** — only the predefined two-category keyword set.
- **5-point or tier-shaped reaction scale** — single-axis fire vs trash chosen for clarity.
- **Reactions from non-channel users** — only votes from members of the configured channel count. External / guest user reactions are ignored at parse time.
- **Backfilling votes for messages posted before this feature ships** — start fresh from go-live.

### Future Considerations

- Phase 2 web UI rendering top plays from the snapshot table.
- Daily/weekly digest posts once the curation use case proves out.
- Vote weighting if the channel grows past 3 reviewers and signal-quality varies.
- LLM-driven thread comment summarization for richer tier dispute analysis.
- Auto re-tiering once the classifier feedback loop has enough labeled data to validate threshold changes.

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Voting purpose | Tier feedback + curation + taste log (unified) | With N=3, the three uses collapse into "small panel of trusted reviewers". |
| Voters | Anyone in channel | N=3, all trusted; no allowlist needed. |
| Mechanic | Slack reactions + threaded comments | Zero UI friction for votes; comments capture qualitative signal. |
| Voting window | 24 hours from post | Forces freshness, makes snapshots stable. |
| Reaction set | `:fire:` (great) vs `:wastebasket:` (not noteworthy / mis-detected) | Single axis maps cleanly to a binary signal. |
| Tier review threshold | Majority (2+ of 3 contradict) | Filters lone-vote noise without requiring unanimity. |
| Tier display retro-update | Never | Votes are labels, not truth. |
| Comment tag categories | Tier disputes + video issues | Targeted keywords for the two highest-value qualitative signals. |
| On-close actions | Lock snapshot + mark for tier review | Other on-close actions (digest, edit message) deferred or rejected. |
| Message structure | Game header + thread reply per play | Per-play vote attribution. Schema migration to split message tracking. Webhook fallback keeps single-message behavior. |

---

*This contract was generated from brain dump input. Review and approve before proceeding to PRD generation.*
