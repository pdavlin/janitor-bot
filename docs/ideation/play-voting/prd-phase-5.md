# PRD: play-voting - Phase 5

**Contract**: ./contract.md
**Phase**: 5 of 5 (added after phase 4 was scoped)
**Focus**: Weekly LLM-driven analysis of game-thread discussion to surface systematic classification biases for operator review. Always pairs with a deterministic SQL baseline so the LLM is the interpretation layer, not the source of truth.

## Phase Overview

Phases 2 and 3 capture quantitative (votes) and lightly-structured qualitative (regex tags) signal in real time. Phase 5 layers a periodic, deeper read: a weekly run that ingests the past week's plays, vote snapshots, regex tags, and full thread transcripts, then produces a digest of *systematic patterns* the operator should consider when adjusting `src/detection/ranking.ts` thresholds.

The agent does not auto-tune the classifier. The bot's tier logic is rules-based code; "improvement over time" happens through the operator-assisted refinement loop:

1. Bot detects play, classifies tier (rules)
2. Channel reacts and discusses (votes + comments)
3. Run combines a deterministic SQL baseline with an LLM interpretation pass
4. Operator reads digest, marks each finding `confirmed` or `rejected`, decides if a threshold needs adjusting, ships a code change
5. Future detection benefits

The killer feature is what regex + votes can't surface alone: cross-play patterns expressed in prose. *"Across 8 high-tier plays this week, 5 received 2+ trash votes — all 5 had only one runner on base"* drives a real rule change. The SQL baseline ships the same week so the LLM is graded against numbers the operator could compute themselves.

After phase 5, Sunday morning the operator opens Slack to a single digest message in the existing channel summarizing the week's classification health. Each finding cites the specific code area to consider tuning, carries a strength label, and is open for `confirmed`/`rejected` follow-up.

## User Stories

1. As the operator, I want a weekly summary of how the channel reacted to the bot's classifications, so that I can spot drift in the detection rules without scrolling Slack history.
2. As a channel reviewer, I want to see what the bot's review found, so that I can correct it ("no, that wastebasket was a joke") and improve next week's read.
3. As the operator, I want each finding to point at a specific named code area to tune, so my action is concrete instead of "go figure something out."
4. As the operator, I want a deterministic SQL baseline alongside the LLM interpretation, so I can sanity-check the agent against numbers I could compute myself.
5. As the operator, I want user-typed comment content kept out of long-term storage and out of the Slack digest, so the DB doesn't accumulate a chat archive.
6. As the operator, I want a way to mark each finding `confirmed` or `rejected`, so I can measure the agent's hit rate before promoting it to cron.

## Functional Requirements

### CLI Trigger

- **FR-5.1**: New CLI command `bun run weekly-review`. Standalone process, not part of the daemon.
- **FR-5.2**: Manual invocation only in v1. Promotion to OS-level cron is gated on the agent's measured hit rate (see FR-5.30). Explicitly NOT a peer task in `src/daemon/scheduler.ts` — the daemon's frequent restart cycle would interrupt mid-run LLM calls.
- **FR-5.3**: CLI accepts `--week-starting YYYY-MM-DD` for replay or backfill. Week boundaries are computed in `America/Chicago` to match the daemon's existing date handling (`src/daemon/scheduler.ts` uses local time for game dates). The default window is the most recent **complete** Sunday-to-Saturday week — if today is Sunday through Saturday and the current week has not yet ended, defaults to the prior complete week. Override always available via `--week-starting`.
- **FR-5.4**: CLI accepts `--dry-run` to print the prepared prompt and the parsed agent response without posting to Slack or persisting findings.
- **FR-5.5**: CLI accepts `--stats-only` to compute and post the SQL baseline only — no LLM call, no findings rows. Used as the v0 fallback and as an LLM-vs-baseline comparison during the trust-calibration phase.
- **FR-5.6**: CLI accepts `--show-last` to print the most recent run's findings to stdout in human-readable form. No API or Slack calls.
- **FR-5.7**: CLI is implemented as a single entry point (`src/cli/weekly-review.ts`) that dispatches on flags. Spec defines the dispatcher; do not split into multiple CLIs.

### Concurrent-Run Safety

- **FR-5.8**: Before any LLM call or Slack post, insert a row into `agent_runs` with `status='started'`. The schema enforces a partial unique index on `(week_starting) WHERE status='started'`, so a second concurrent invocation fails on insert and exits non-zero with a clear error.
- **FR-5.9**: A run that crashes between `started` and `success`/`error` leaves a stale `started` row. The CLI accepts `--force-clear-stale-lock` to delete `started` rows older than 1 hour for the target week. Emit a warn when this is used.

### Data Gathering

- **FR-5.10**: For the target week, gather from the DB:
  - All `plays` rows where `date` falls in the window
  - All `vote_snapshots` rows joined to those plays
  - All `play_tags` rows joined to those plays (omitted when phase 3 has not landed; see FR-5.34)
  - The bot's `slack_game_headers` ts and channel for each game in the window
- **FR-5.11**: For each game with a recorded header ts, fetch the full thread transcript live via Slack's `conversations.replies` API. Hold transcripts in process memory only.
- **FR-5.12**: If a thread has zero replies, skip the API call and exclude that game from the agent's transcript bundle.
- **FR-5.13**: When building the transcript bundle, exclude messages where:
  - `user == bot_user_id` (the bot's own posts and seeded reactions)
  - `ts` matches any prior `agent_runs.posted_message_ts` (the digest itself)
  - `parent_ts` matches any prior `agent_runs.posted_message_ts` (replies to the digest, surfaced separately under "Channel Corrections")
- **FR-5.14**: Per-game transcript token cap of 2000 tokens. When over the cap, truncate oldest messages first; preserve the most recent discussion. Note in the prompt that the transcript is truncated.

### Memory-Only Enforcement

- **FR-5.15**: Transcript content must never appear in:
  - any DB INSERT or UPDATE
  - any log line (info, warn, error)
  - any Slack message body
  - any error message
- **FR-5.16**: Enforced via:
  1. A typed `Transcript` wrapper that is never accepted by persistence/logging APIs.
  2. A CI test that greps the run code for transcript field names appearing in DB write paths or log payloads. Build is red on a match.
- **FR-5.17**: NFR-5.3 (the older "code review will catch it") is replaced by FR-5.15 + FR-5.16 as enforceable controls.

### Minimum-Signal Gate

- **FR-5.18**: Skip the LLM call entirely when either:
  - `plays` count for the week < 5
  - `votes` count for the week < 5
- **FR-5.19**: When skipped, post a one-line Slack digest: `Insufficient data this week — N plays, M votes.` Persist an `agent_runs` row with `status='success'` and zero findings rows so the run is recorded but billable work is zero.

### SQL Baseline

- **FR-5.20**: Every digest (LLM-enabled or not) leads with the deterministic SQL baseline. Computed via fixed queries against `vote_snapshots` joined to `plays`:
  - Vote totals by tier
  - Top 5 plays by net score (positive)
  - Top 5 plays by net score (negative)
  - Tier-review-flagged play count
  - Per-`runners_on` and per-`fielder_position` aggregations of fire/trash counts
- **FR-5.21**: The baseline appears in the Slack digest above any LLM findings. The LLM section is explicitly framed as "interpretation," not "source of truth."
- **FR-5.22**: `--stats-only` mode posts only this section.

### Agent Prompt

- **FR-5.23**: Single-pass agent call. Model is configurable via env (`AGENT_MODEL`, default `claude-sonnet-4-6`). Provider is Anthropic API; new env `ANTHROPIC_API_KEY` required.
- **FR-5.24**: System prompt establishes:
  - The bot's tier rules (briefly)
  - The goal: identify systematic biases covering ≥2 plays
  - **Output discipline (hard rules)**:
    - Do not quote or paraphrase user comments
    - Do not include Slack mentions, URLs, or user IDs
    - Describe patterns abstractly (e.g., "channel pushed back on RF→Home throws," not "as user X said, '...'")
    - Output strictly the specified JSON schema; no prose outside it
- **FR-5.25**: User prompt provides:
  - Play list with metadata + classifications
  - Vote tallies
  - Regex tags (when phase 3 has landed)
  - Per-game thread transcripts (token-capped)
  - Past 8 weeks of `agent_findings` for context (configurable via `AGENT_HISTORY_WEEKS` env)
  - A separate "Channel Corrections" section containing replies to prior digest messages, labeled as weak signal
- **FR-5.26**: Prompt explicitly forbids per-play tier judgments ("this play should have been medium not high") and code-change suggestions in v1 — those are votes' and the operator's jobs respectively. Reconsidered after the trust-calibration milestone (FR-5.30).

### Output Validation

- **FR-5.27**: After receiving the LLM response, validate every finding's `description` field:
  - Reject if it contains quotation marks (`"`, `“`, `”`, `'`)
  - Reject if it contains Slack mention syntax (`<@`, `<#`, `<!`)
  - Reject if any 30-character contiguous substring matches any transcript message verbatim
- **FR-5.28**: A finding that fails validation is dropped from the run. Dropped findings are logged at warn level with the `finding_type` (not the description).
- **FR-5.29**: If all findings are dropped, the run still completes successfully with the SQL baseline only and a note: `LLM findings withheld this week — N findings failed output validation.`

### Trust Calibration

- **FR-5.30**: Each `agent_findings` row carries an `outcome` column:
  - `pending` (initial state)
  - `confirmed` (operator agreed and shipped or queued a change)
  - `rejected` (operator disagreed)
  - `ignored` (no operator action within 14 days; auto-set by the next run that finds a `pending` row past the deadline)
- **FR-5.31**: `bun run weekly-review --resolve <run_id> <finding_id> <confirmed|rejected>` updates the outcome.
- **FR-5.32**: Each digest includes the running confirmed-rate over the past 8 weeks (`hit rate: X / Y findings confirmed`). Cron promotion is gated on hit rate ≥ 50% over at least 8 weeks of data.

### Severity Rubric

- **FR-5.33**: Severity is assigned per finding by the LLM under explicit rules baked into the system prompt. Single-run grounded (does not require cross-week computation):
  - **`info`**: weak signal — 2–3 plays, mixed or unclear vote signal
  - **`watch`**: moderate pattern — ≥4 plays, consistent directional signal
  - **`act`**: strong mismatch — clear majority disagreement with the classifier across the affected plays
- **FR-5.34**: Cross-week recurrence is captured in a separate `trend` field (`first_seen` / `recurring` / `escalating` / `cooling`). The agent computes this by comparing this run's findings to the past 8 weeks.

### Operator Unit-of-Action

- **FR-5.35**: Each finding includes a required `suspected_rule_area` field with a value from a curated allow-list of identifiers (not free text). Initial allow-list, derived from the actual symbols in `src/detection/ranking.ts` and `src/detection/detect.ts` as of phase 5 implementation:
  - `ranking.ts:target_base_scores` (Home=4, 3B=3, 2B=1 — the if/else block in `calculateTier`)
  - `ranking.ts:direct_throw_bonus` (the `segments.length === 2` bonus)
  - `ranking.ts:video_bonus` (the `hasVideo` bonus)
  - `ranking.ts:tier_thresholds` (`score >= 5` for high, `score >= 3` for medium)
  - `detect.ts:outfield_codes` (which positions count as outfielders)
  - `detect.ts:skip_events` (event types excluded from detection)
  - `new_tunable_needed` (the pattern points at a factor the bot doesn't currently consider — e.g., runners_on, outs, leverage. The operator would need to ADD a new tunable, not modify an existing one.)
  - `unknown` (fallback for findings the agent can't map; flagged for prompt iteration)
- **FR-5.36**: The allow-list lives in a single source file (`src/cli/weekly-review/rule-areas.ts`) so additions don't require touching the parser. Allow-list values are validated server-side after the LLM response; an invalid value is normalized to `unknown` and a warn is logged.

### Evidence Strength

- **FR-5.37**: Each finding includes a required `evidence_strength` field with values:
  - `weak` (2–3 plays)
  - `moderate` (4–6 plays)
  - `strong` (7+ plays)
- **FR-5.38**: Operators can filter the digest with the `--min-strength` flag (e.g., `--min-strength=moderate`). Default in Slack post is `weak` (show everything).

### Cost Telemetry

- **FR-5.39**: Persist on `agent_runs`:
  - `input_tokens` (from API response usage)
  - `output_tokens`
  - `estimated_cost_usd` (computed from current model pricing)
- **FR-5.40**: Log a warn pre-call if estimated input tokens exceed 100k. Log a warn post-call if `estimated_cost_usd` exceeds $1.

### Output Schema (DB)

- **FR-5.41**: New table `agent_runs`:
  - `id` PK, `week_starting` (date YYYY-MM-DD, Sunday), `model` text, `started_at`, `completed_at` nullable, `status` (`started`|`success`|`error`), `error_text` nullable, `posted_message_ts` nullable, `input_tokens` nullable, `output_tokens` nullable, `estimated_cost_usd` nullable.
- **FR-5.42**: New table `agent_findings`:
  - `id` PK, `run_id` FK, `finding_type` text, `description` text (validated per FR-5.27), `severity` (`info`|`watch`|`act`), `evidence_strength` (`weak`|`moderate`|`strong`), `evidence_play_ids` JSON array, `suspected_rule_area` text (from allow-list), `trend` (`first_seen`|`recurring`|`escalating`|`cooling`) nullable, `outcome` (`pending`|`confirmed`|`rejected`|`ignored`) default `pending`, `resolved_at` nullable, `resolved_by_run_id` nullable, `created_at`.
- **FR-5.43**: Findings are append-only. Old runs are never deleted.

### Slack Digest

- **FR-5.44**: After persisting findings, post a single message to `SLACK_CHANNEL_ID` via `chat.postMessage` (existing bot token, no new scope).
- **FR-5.45**: Single message only — no threaded replies. If the message would exceed Slack's block limit (3000 chars in a section), individual finding `description` fields are truncated to 280 chars with a `…` suffix; `agent_findings.description` keeps the full text in DB.
- **FR-5.46**: Findings are ordered by:
  1. `severity` desc (`act` → `watch` → `info`)
  2. `evidence_strength` desc (`strong` → `moderate` → `weak`)
  3. evidence play count desc
- **FR-5.47**: Empty-findings handling: when zero findings remain after validation, post the SQL baseline plus the line: `No systematic patterns detected this week.`
- **FR-5.48**: Format:
  ```
  *Weekly classification review — week of YYYY-MM-DD to YYYY-MM-DD*

  Summary: N plays detected · M with votes · K flagged for tier review · hit rate over last 8 weeks: X/Y

  Baseline: [SQL summary, ≤5 lines]

  Findings (N):
  • [act, strong] {desc} — area: ranking.ts:foo — 5 plays
  • [watch, moderate] {desc} — area: ranking.ts:bar — 4 plays
  ...

  Resolve with: bun run weekly-review --resolve {run_id} {finding_id} {confirmed|rejected}
  ```
- **FR-5.49**: The digest message's Slack `ts` is recorded in `agent_runs.posted_message_ts`.

### Retry Policy

- **FR-5.50**: On a transient LLM failure (network error, 5xx, rate limit), retry once after a 5s delay. Persist a single `agent_runs` row regardless of retry count; record the retry in logs. On second failure, status=`error`, no findings, no Slack post.

### Retention Sweep

- **FR-5.51**: Phase 5 owns the long-term retention sweep. After each successful run, execute:
  ```sql
  UPDATE play_tags SET matched_text = NULL WHERE received_at < datetime('now', '-12 weeks');
  ```
- **FR-5.52**: `agent_findings.description` is constrained at write time (FR-5.27) so it should not contain user prose. As defense-in-depth, the same sweep also nulls `agent_findings.description` for rows older than 12 weeks. The structured columns (`finding_type`, `severity`, `evidence_strength`, `suspected_rule_area`, `evidence_play_ids`, `outcome`) remain.
- **FR-5.53**: Sweep is idempotent (rows already nulled are no-ops). Phase 5 does not delete rows — only blanks the prose columns.

## Non-Functional Requirements

- **NFR-5.1**: Total run time under 60 seconds for a typical week's data.
- **NFR-5.2**: Cost per run < $1 USD with `claude-sonnet-4-6` at the assumed prompt budget. Enforced via FR-5.39 cost telemetry plus FR-5.40 warning thresholds.
- **NFR-5.3**: Memory-only handling of transcripts is enforced by FR-5.15 + FR-5.16 (typed boundary + CI test). No per-table prose persistence outside the validated `description` column.
- **NFR-5.4**: Run is safe to re-execute on the same week. The concurrent-run lock (FR-5.8) prevents parallel races; sequential re-runs after a `success` create a new `agent_runs` row.
- **NFR-5.5**: All SQL parameterized; no string concat.
- **NFR-5.6**: No new Slack scopes required. `channels:history` (already loaded in phase 2) is the scope `conversations.replies` consumes.
- **NFR-5.7**: Slack digest message body fits within a single `chat.postMessage` request — no fallback to threaded replies in v1.

## Schema Changes

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  week_starting       TEXT NOT NULL,                  -- YYYY-MM-DD (Sunday)
  model               TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  completed_at        TEXT,
  status              TEXT NOT NULL CHECK (status IN ('started', 'success', 'error')),
  error_text          TEXT,
  posted_message_ts   TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  estimated_cost_usd  REAL
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_week_starting
  ON agent_runs(week_starting DESC);

-- Concurrent-run lock: only one row per week can be in `started` state.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_started_lock
  ON agent_runs(week_starting) WHERE status = 'started';

CREATE TABLE IF NOT EXISTS agent_findings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                INTEGER NOT NULL REFERENCES agent_runs(id),
  finding_type          TEXT NOT NULL,
  description           TEXT,                            -- nullable: validated free of user prose at write time, then nulled by the 12-week retention sweep (FR-5.52)
  severity              TEXT NOT NULL CHECK (severity IN ('info', 'watch', 'act')),
  evidence_strength     TEXT NOT NULL CHECK (evidence_strength IN ('weak', 'moderate', 'strong')),
  evidence_play_ids     TEXT NOT NULL,                  -- JSON array
  suspected_rule_area   TEXT NOT NULL,                  -- from allow-list, normalized to 'unknown' on miss
  trend                 TEXT CHECK (trend IN ('first_seen', 'recurring', 'escalating', 'cooling') OR trend IS NULL),
  outcome               TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'confirmed', 'rejected', 'ignored')),
  resolved_at           TEXT,
  resolved_by_run_id    INTEGER REFERENCES agent_runs(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_findings_run_id
  ON agent_findings(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_findings_outcome
  ON agent_findings(outcome) WHERE outcome = 'pending';
```

## Dependencies

### Prerequisites

- Phase 3 (`play_tags` table + regex parser) lands first when possible. Phase 5 ships with graceful degrade if it doesn't (FR-5.10).
- Phase 4 not required.
- Anthropic API key in env (`ANTHROPIC_API_KEY`). Distinct from Slack credentials.
- `@anthropic-ai/sdk` added to `package.json` runtime dependencies (currently the project has only devDependencies — first runtime dep).
- `loadConfig()` extended with `ANTHROPIC_API_KEY` validation matching the existing pattern (e.g., `MIN_TIER`).

### Outputs for Future Phases

- `agent_runs` and `agent_findings` tables that phase 4's web UI can render in a "review" tab.
- Operator-validated prompt template that survives the v1 → v1.1 transition (graduate from manual to cron once hit rate threshold met).

## Discussion Log (locked decisions)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Prescriptiveness | **A: Pattern report only.** Agent describes; operator decides code changes. | Concrete code suggestions are seductive but error-prone early; A keeps human in the loop. Reconsider once hit rate ≥ 50% over 8 weeks (FR-5.32). |
| 2 | Posting destination | **A: Existing channel, single message.** | Visibility creates accountability and lets the channel correct the agent. Separate channel = audience of one = ignored. |
| 3 | Phase 3 tag retention | **C: Null `matched_text` after 12 weeks.** | Satisfies the no-archive intent without losing aggregates. Phase 5 owns the sweep. |
| 4 | Run trigger | **A: Manual CLI to start.** Move to OS cron after measured hit rate ≥ 50% × 8 weeks. | Frequent prod deploys + long LLM call inside daemon = fragile. Manual triggering forces engagement with the output. |
| 5 | LLM-vs-baseline | **Always include SQL baseline alongside LLM findings.** | Forces the LLM to add value over what SQL alone gives the operator. `--stats-only` mode is the v0 fallback. |
| 6 | User-text leakage | **Multi-layer defense: prompt rule + post-parse validation + retention sweep on description.** | A single layer (prompt only) will silently fail. Validation catches what the prompt misses; sweep catches what validation misses. |
| 7 | Concurrent-run safety | **`status='started'` row + partial unique index on `(week_starting) WHERE status='started'`.** | Idempotency requires explicit locking. Two parallel runs would otherwise produce two Slack posts. |
| 8 | Severity rubric | **Single-run grounded** (play count + signal consistency). Cross-week recurrence captured separately via `trend` field. | Original "across weeks" severity is undefined the first week. Single-run grounding is the simplest defensible rule. |
| 9 | Operator unit-of-action | **Required `suspected_rule_area` from a curated allow-list of identifiers.** | Free text becomes ignorable noise. Identifier-mapped findings point at concrete code areas. |
| 10 | CLI structure | **Single entry point with flag-based modes** (not multiple scripts). | Aligns with the project's existing CLI pattern; no precedent for split entry points. |

## Open Questions

- **Past-findings prompt context window** (currently 8 weeks via `AGENT_HISTORY_WEEKS`). May need tuning once real data accumulates.
- **`--min-strength` default in CLI** (currently `weak` to show everything). Slack post default is fine; CLI users may want `moderate` once they've seen a few weeks.
- **Allow-list maintenance**: when the operator ships a `ranking.ts` change that creates a new threshold, who updates the allow-list? Lightweight process; defer to spec time.
- **Cron promotion threshold** (currently 50% confirmed rate over 8 weeks). Likely too generous; tune once the trust calibration data is in.

## Acceptance Criteria

- [ ] `bun run weekly-review --dry-run` prints a well-formed prompt and exits 0 without making any LLM, Slack, or DB writes.
- [ ] `bun run weekly-review --stats-only` posts a Slack message with the SQL baseline and no LLM section, no findings rows persisted.
- [ ] `bun run weekly-review` against a week of seeded data produces:
  - one `agent_runs` row transitioning `started → success`
  - one or more `agent_findings` rows
  - a Slack message in the configured channel with the SQL baseline + LLM findings
- [ ] A second concurrent `bun run weekly-review` against the same week fails fast with a clear error and does not produce a duplicate Slack post.
- [ ] An LLM response containing user-quoted text in a `description` is dropped at write time and logged at warn; `agent_findings` does not contain it.
- [ ] When fewer than 5 plays or 5 votes exist for the week, no LLM call is made; the digest reads "Insufficient data this week."
- [ ] Each `agent_findings` row has `suspected_rule_area` set to a value from the allow-list or `unknown`.
- [ ] `bun run weekly-review --resolve <run> <finding> confirmed` updates the outcome; the next digest's hit-rate footer reflects it.
- [ ] No row in any table contains a full Slack message body. The only persisted user-typed prose is `play_tags.matched_text`, capped at 12 weeks via the retention sweep.
- [ ] `agent_findings.description` is also nulled after 12 weeks as defense-in-depth.
- [ ] Findings rendered in the Slack post are ordered by severity → evidence_strength → play count.
- [ ] When all LLM findings fail validation, the digest still posts with the SQL baseline plus a note that LLM findings were withheld.
- [ ] When zero LLM findings are produced, the digest posts the SQL baseline plus "No systematic patterns detected this week."
- [ ] Transient LLM failure triggers exactly one retry; second failure persists `status='error'` and does not post to Slack.
- [ ] `bun test` passes including new tests for the gather query, prompt builder, response parser, validation rejection, retention sweep, concurrent-run lock, and CLI flag dispatch.
- [ ] CI test rejects any PR that introduces a transcript field name into a DB write path or log payload.

## Minimum Set Locked Before Spec

If only three constraints are enforced before the spec author starts:

1. **No user text in findings**: prompt rule + post-parse validation + defense-in-depth retention sweep on `agent_findings.description`.
2. **Per-week run lock**: `status='started'` row plus partial unique index.
3. **SQL baseline always alongside LLM**: every digest leads with deterministic stats; LLM is interpretation only.

These three define whether the system is trustworthy.

---

*This PRD is ready for review. Generate spec-phase-5.md after approval.*
