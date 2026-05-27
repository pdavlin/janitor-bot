# Implementation Spec: rematch-agent - Phase 2

**PRD**: ./prd-phase-2.md
**Estimated Effort**: M

## Technical Approach

Wire the Phase 1 `rematchVideo` function into the live Slack reaction flow. Three structural pieces:

1. **Seed**: extend `seedVoteReactions` to seed `:repeat:` alongside the existing `:fire:` and `:wastebasket:` so users tap an already-present reaction.
2. **Route**: add a third branch in `handleReactionEvent` (in `slack-events.ts`) that fires when `event.reaction === "repeat"`. It resolves the play via the existing `lookupPlayMessageByTs`, applies the `isVotingEligible` (is_bot=false) gate, and invokes a new orchestrator.
3. **Orchestrate**: a new module `src/notifications/play-rematch-handler.ts` owns the per-reaction flow: read play row → check dedupe → fetch game video list → call `rematchVideo` → write event row → optionally update `plays.video_url` + edit Slack message + post thread reply.

Async semantics: Slack expects a 200 within 3 seconds. The existing dispatcher already returns synchronously to the HTTP handler and runs the reaction handlers without blocking the ack (it's fire-and-forget from the route's perspective). The new handler can run the same way. The Anthropic call (up to ~30s) is the long tail and must not block the dispatch loop — verify the current invocation point and, if needed, wrap the new handler in a non-awaited promise that logs its own errors.

The video candidate list is the only piece of state we don't already have in SQLite. Two options:
- **Refetch the game's content API response on each re-match**. Simple, slow (one HTTP call), bounded by MLB's rate limits (we already call this API in the daily flow).
- **Cache the candidate list at first-pass time**. Adds a new column or table to `plays`. Cheaper per re-match, larger blast radius.

Re-matches are expected to be rare (the contract emphasises low volume). Pick **refetch on demand**, reusing whatever helper `matchVideoToPlay` is fed by today (likely a wrapper around the MLB content API). Caching is a future optimization.

## File Changes

### New Files

| File Path | Purpose |
|-----------|---------|
| `src/notifications/play-rematch-handler.ts` | Orchestrator: routes a `:repeat:` reaction through dedupe, agent, persistence, Slack edit, and thread reply. |
| `src/notifications/play-rematch-events-store.ts` | DB helpers: insert event, read latest event for `(game_pk, play_index)`. Mirrors `finding-resolution-events-store.ts`. |
| `src/notifications/__tests__/play-rematch-handler.test.ts` | Integration test of the orchestrator with mocked `rematchVideo`, mocked Slack client, in-memory SQLite. |
| `src/notifications/__tests__/play-rematch-events-store.test.ts` | Unit tests for insert / latest-event-lookup. |

### Modified Files

| File Path | Changes |
|-----------|---------|
| `src/storage/db.ts` | Add `CREATE_PLAY_REMATCH_EVENTS_TABLE_SQL` and its index; register in the schema init list. |
| `src/notifications/slack-client.ts` | Add `"repeat"` to `SEED_REACTIONS`. Add a new exported helper `editPlayMessage(config, channel, ts, payload, logger)` wrapping `chat.update`. |
| `src/notifications/slack-events.ts` | Add a `repeat` branch in `handleReactionEvent`. Skip `reaction_removed` for `:repeat:`. Reject bot reactions via the existing `isVotingEligible` flow. |
| `src/notifications/slack-formatter.ts` | No behaviour change, but extract the per-play block builder if it isn't already exported, so the re-match handler can re-render with a new video URL. |
| `src/config.ts` | Add `rematchAgentEnabled` (env: `REMATCH_AGENT_ENABLED`, default false) and reuse the existing Anthropic API key + model fields. |
| `src/cli/weekly-review/agent.ts` | Already changed in Phase 1 to export `defaultClient`. No further change. |

## Implementation Details

### Schema migration

```sql
CREATE TABLE IF NOT EXISTS play_rematch_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  game_pk          INTEGER NOT NULL,
  play_index       INTEGER NOT NULL,
  user_id          TEXT    NOT NULL,
  prior_video_url  TEXT,
  new_video_url    TEXT,
  decision         TEXT    NOT NULL CHECK (decision IN ('swapped','agreed','no_match','deduped')),
  agent_reason     TEXT,
  event_ts         TEXT    NOT NULL,
  received_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_play_rematch_events_play
  ON play_rematch_events(game_pk, play_index, id DESC);
```

Follow the same pattern as `CREATE_FINDING_RESOLUTION_EVENTS_TABLE_SQL` in `db.ts`. Register the new SQL in whichever array drives `initDb`.

### `play-rematch-events-store.ts`

**Pattern to follow**: `src/notifications/finding-resolution-events-store.ts`.

```typescript
export type RematchDecision = "swapped" | "agreed" | "no_match" | "deduped";

export interface PlayRematchEvent {
  gamePk: number;
  playIndex: number;
  userId: string;
  priorVideoUrl: string | null;
  newVideoUrl: string | null;
  decision: RematchDecision;
  agentReason: string | null;
  eventTs: string;
}

export function insertPlayRematchEvent(
  db: Database,
  evt: PlayRematchEvent,
): void { /* INSERT INTO play_rematch_events ... */ }

export function getLatestRematchEvent(
  db: Database,
  gamePk: number,
  playIndex: number,
): PlayRematchEvent | null { /* SELECT ... ORDER BY id DESC LIMIT 1 */ }
```

### Reaction routing in `slack-events.ts`

Insert a new branch ahead of the existing `reactionToDirection` / `reactionToResolutionDirection` branches:

```typescript
async function handleReactionEvent(event, ctx): Promise<void> {
  if (event.type === "reaction_added" && event.reaction === "repeat") {
    await handleRematchReaction(event, ctx);
    return;
  }
  // ... existing branches unchanged
}

async function handleRematchReaction(event, ctx): Promise<void> {
  const lookup = lookupPlayMessageByTs(ctx.db, event.item.channel, event.item.ts);
  if (!lookup) return;

  const userInfo = await getUserInfo(ctx.slackConfig, event.user, ctx.logger);
  if (!isVotingEligible(userInfo)) return;  // skips bot's own seed

  await rematchPlay({
    db: ctx.db,
    slackConfig: ctx.slackConfig,
    logger: ctx.logger,
    channel: event.item.channel,
    ts: event.item.ts,
    gamePk: lookup.gamePk,
    playIndex: lookup.playIndex,
    userId: event.user,
    eventTs: event.event_ts,
  });
}
```

`reaction_removed` for `:repeat:` is ignored — falls through to the existing logic which already no-ops on unknown reactions.

**Key decisions**:
- `:repeat:` is checked **before** the vote/finding routing so the disjoint emoji sets cannot collide; `repeat` is not in either of those maps anyway.
- The `:repeat:` branch is gated by `ctx.slackConfig` reading the feature flag indirectly — actually wire the flag check at the boundary where `dispatchEvent` is called (or inside `handleRematchReaction` as a single early return). Either works; spec keeps the flag check inside `handleRematchReaction` so disabling the flag fully short-circuits.

### `play-rematch-handler.ts` orchestrator

```typescript
export interface RematchPlayArgs {
  db: Database;
  slackConfig: SlackClientConfig;
  logger: Logger;
  channel: string;
  ts: string;
  gamePk: number;
  playIndex: number;
  userId: string;
  eventTs: string;
}

export async function rematchPlay(args: RematchPlayArgs): Promise<void> {
  // 1. Feature flag check.
  if (!getRematchEnabled()) return;

  // 2. Read play row: description, fielder_id, video_url, video_title.
  const play = readPlay(args.db, args.gamePk, args.playIndex);
  if (!play) return;

  // 3. Dedupe: latest event row whose prior_video_url equals current video_url
  //    (both NULL treated as equal) means we've already attempted at this state.
  const latest = getLatestRematchEvent(args.db, args.gamePk, args.playIndex);
  if (latest && sameVideo(latest.priorVideoUrl, play.video_url) && latest.decision !== 'deduped') {
    // Already tried at this state; record the dedupe and stop.
    insertPlayRematchEvent(args.db, {
      ...baseEvent(args),
      priorVideoUrl: play.video_url,
      newVideoUrl: null,
      decision: 'deduped',
      agentReason: null,
    });
    return;
  }

  // 4. Fetch the game's video candidate list.
  const candidates = await fetchGameVideos(args.gamePk, args.logger);
  if (candidates.length === 0) {
    insertPlayRematchEvent(args.db, {
      ...baseEvent(args),
      priorVideoUrl: play.video_url,
      newVideoUrl: null,
      decision: 'no_match',
      agentReason: 'no candidates available from MLB API',
    });
    return;
  }

  // 5. Map current video_url -> highlight id (string match against candidate URLs).
  const currentVideoId = findCandidateIdForUrl(play.video_url, candidates);

  // 6. Invoke the agent.
  let result: RematchResult;
  try {
    result = await rematchVideo(getApiKey(), getModel(), {
      playDescription: play.description,
      currentVideoId,
      candidates: candidates.map(toRematchCandidate),
      gamePk: args.gamePk,
    }, args.logger);
  } catch (err) {
    args.logger.error('rematch agent threw', { err });
    await postThreadReply(args, 'Re-match request failed — see logs.');
    return;
  }

  // 7. Apply the outcome.
  await applyOutcome(args, play, result, candidates);
}
```

**`applyOutcome` per-decision**:

```typescript
case 'swapped': {
  const chosen = candidates.find(c => c.id === result.videoId);
  const newUrl = selectPlaybackUrl(chosen.playbacks);  // reuse from video-match.ts
  // Single transaction: update plays, insert event row.
  db.transaction(() => {
    db.prepare(`UPDATE plays SET video_url = $url, video_title = $title
                WHERE game_pk = $gp AND play_index = $pi`)
      .run({ $url: newUrl, $title: chosen.title, $gp: args.gamePk, $pi: args.playIndex });
    insertPlayRematchEvent(db, { ...baseEvent(args), priorVideoUrl: play.video_url,
      newVideoUrl: newUrl, decision: 'swapped', agentReason: result.reason ?? null });
  })();
  // Re-render the play block and chat.update; thread-reply on success.
  const updatedPlay = { ...play, videoUrl: newUrl, videoTitle: chosen.title };
  const payload = buildPlayReplyMessage(updatedPlay);  // reuse from slack-formatter
  const ok = await editPlayMessage(slackConfig, args.channel, args.ts, payload, logger);
  const note = ok ? `Re-matched video at <@${args.userId}>'s request.`
                  : `Re-matched video at <@${args.userId}>'s request (message edit failed — see logs).`;
  await postThreadTextWithTs(slackConfig, args.channel, args.ts, note, logger);
  break;
}
case 'agreed': {
  insertPlayRematchEvent(db, { ...baseEvent(args), priorVideoUrl: play.video_url,
    newVideoUrl: play.video_url, decision: 'agreed', agentReason: result.reason ?? null });
  await postThreadTextWithTs(slackConfig, args.channel, args.ts,
    `Agent reviewed at <@${args.userId}>'s request and agreed with the current video.`, logger);
  break;
}
case 'no_match': {
  insertPlayRematchEvent(db, { ...baseEvent(args), priorVideoUrl: play.video_url,
    newVideoUrl: null, decision: 'no_match', agentReason: result.reason ?? null });
  await postThreadTextWithTs(slackConfig, args.channel, args.ts,
    `Agent could not identify a better video at <@${args.userId}>'s request.`, logger);
  break;
}
```

**Key decisions**:
- `sameVideo(a, b)`: `a === b || (a == null && b == null)`. The null-equal-null branch covers the no-video baseline so we dedupe correctly when the play has never had a video.
- Event row written even on `deduped` so we can analyse how often users tap a stale reaction.
- All DB writes for `swapped` are in one `db.transaction` so we never leave a state where the plays row was updated but no event row was written (or vice versa).
- `editPlayMessage` failures still post a thread reply (with the inline note) so the user gets feedback; the row is already written transactionally.

### Seeding `:repeat:`

```typescript
// slack-client.ts
const SEED_REACTIONS: readonly string[] = ["fire", "wastebasket", "repeat"];
```

That single-line change in the array is the entire seed wiring. No change needed at the call site in `slack-client.ts:515`.

### `editPlayMessage` helper

```typescript
export async function editPlayMessage(
  config: SlackClientConfig,
  channel: string,
  ts: string,
  payload: { blocks: unknown[]; text: string },
  logger: Logger,
): Promise<boolean> {
  if (!config.botToken) return false;
  const result = await callSlackApi<{ ok: true }>(
    "chat.update",
    { channel, ts, blocks: payload.blocks, text: payload.text },
    config.botToken,
    logger,
  );
  return result != null;
}
```

## Data Model

See "Schema migration" above. One new table; one new index. No existing tables modified.

## API Design

None. All effects flow through Slack web API calls (`chat.update`, `chat.postMessage`, `reactions.add`) and the existing reaction-event webhook.

## Testing Requirements

### Unit Tests

| Test File | Coverage |
|-----------|----------|
| `src/notifications/__tests__/play-rematch-events-store.test.ts` | Insert all four decisions, ORDER BY id DESC for latest lookup, NULL handling for prior/new urls. |
| `src/notifications/__tests__/play-rematch-handler.test.ts` | Full orchestrator with mocked `rematchVideo` + mocked Slack client + in-memory SQLite. |

**Key scenarios in `play-rematch-handler.test.ts`**:
- **swap happy path**: agent returns `swapped` → `plays.video_url` updated, `chat.update` called with new URL, thread reply posted, event row inserted with `decision='swapped'`.
- **dedupe**: pre-seed an event row with `prior_video_url === plays.video_url`. New reaction → no agent call, no `chat.update`, no thread reply, one new event row with `decision='deduped'`.
- **null-video dedupe**: play has `video_url IS NULL`, prior event row also has `prior_video_url IS NULL`. New reaction → dedupe.
- **eligible after change**: play `video_url` was `urlA`, prior event was for `urlA` (deduped or swapped). Now `plays.video_url` is `urlB`. New reaction → agent gets called again.
- **agreed**: agent returns `agreed` → no plays update, no `chat.update`, thread reply posted, event row `decision='agreed'`.
- **no_match**: agent returns `no_match` → no plays update, no `chat.update`, thread reply posted, event row `decision='no_match'`.
- **agent throws**: thread reply "failed", error logged, no event row needed (or write one with `decision='no_match'` and reason `agent_threw` — spec **picks no event row** for now; an agent-thrown error is operator-actionable, not a user-actionable outcome).
- **chat.update fails after swap**: plays row already updated transactionally; thread reply posted with the inline "edit failed" note.
- **feature flag disabled**: handler returns immediately, no DB writes, no Slack calls.

### Integration Tests

`src/notifications/__tests__/slack-events.integration.test.ts` (extend existing if present, else add):

- POST a synthetic `reaction_added` envelope with `reaction: 'repeat'` to the dispatcher; assert the handler is invoked with the correct play lookup.
- Same envelope with `event.user === bot_user_id` (bot's own seed) → no agent call, no event row.

### Manual Testing

- [ ] Deploy to the prod VM (per project convention: no staging channel).
- [ ] Run the daily flow so a fresh game header + per-play messages are posted; verify `:repeat:` is pre-seeded on each play message.
- [ ] Tap `:repeat:` on a play whose first-pass video looks correct → expect agent-agreed thread reply, no edit.
- [ ] Tap `:repeat:` on a play whose first-pass video is wrong → expect edit + thread reply.
- [ ] Tap `:repeat:` twice with no intermediate state change → second tap is silently dropped (verify in SQL: `decision='deduped'` row exists).
- [ ] Pick a play that originally had no video → tap `:repeat:` → expect either a `swapped` outcome (link inserted) or `no_match` thread reply.
- [ ] Flip `REMATCH_AGENT_ENABLED=false` → tap → no effect. Re-enable.

## Error Handling

| Error Scenario | Handling Strategy |
|----------------|-------------------|
| `lookupPlayMessageByTs` returns null | Silent ignore — reaction was on a non-play message. |
| `getUserInfo` fails or user is a bot | Silent ignore (existing `isVotingEligible` path). |
| `fetchGameVideos` returns empty | Insert event row with `decision='no_match'`, reason `no candidates available`; post thread reply. |
| `rematchVideo` throws | Log error, post `"Re-match request failed — see logs."` thread reply. No event row written. |
| Agent returns `videoId` not in candidates | Phase 1 already coerces to `no_match`. Handler treats as such. |
| `chat.update` fails | Plays row already updated transactionally; thread reply notes the failure inline so the user knows the source-of-truth was changed even though the visible block didn't refresh. |
| Slack `chat.postMessage` (thread reply) fails | Log warn. No retry. The event row is the durable record. |
| Database constraint violation on insert | Log error, do not post thread reply (don't lie about an action that didn't persist). |

## Validation Commands

```bash
bun run typecheck
bun test src/notifications/__tests__/play-rematch-events-store.test.ts
bun test src/notifications/__tests__/play-rematch-handler.test.ts
bun test  # full suite
```

## Rollout Considerations

- **Feature flag**: `REMATCH_AGENT_ENABLED` (env var, read in `src/config.ts`). Default `false`. Flip to `true` after the daily flow has posted a few games with the new `:repeat:` seed.
- **Monitoring**: every handler invocation logs structured fields (`decision`, `gamePk`, `playIndex`, `userId`). Watch for runs of `agreed` (indicating the agent isn't actually helping) or `no_match` (indicating the candidate list shape is wrong).
- **Alerting**: none in this phase. If the agent's cost climbs, the existing Anthropic cost log line from `rematchVideo` is greppable.
- **Rollback plan**:
  - Set `REMATCH_AGENT_ENABLED=false` and redeploy — handler short-circuits.
  - The seed change is harmless to leave in place: an unhandled `:repeat:` reaction is a no-op once the flag is off.
  - The schema is additive; rolling back code does not require dropping the table.

## Open Items

- [ ] Confirm the existing helper that fetches MLB content for the daily flow is reusable from this handler, or whether we need a thin wrapper to expose it. (Read `src/api/` to find it.)
- [ ] Confirm the bot's `user.id` is reliably populated in `getUserInfo` so `isVotingEligible` filters the seed — there is one project-memory note about Slack token rotation; verify the bot user can still be identified after a token rotate.
- [ ] Decide whether to also seed `:repeat:` on previously-posted plays (a backfill pass) or only on fresh posts going forward. **Default: forward-only.** A backfill is one `reactions.add` per existing play row and is easy to add later if desired.

---

*This spec is ready for implementation. Follow the patterns and validate at each step.*
