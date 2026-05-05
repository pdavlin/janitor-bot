# Implementation Spec: play-voting - Phase 5

**PRD**: ./prd-phase-5.md
**Estimated Effort**: L

## Technical Approach

A new `bun run weekly-review` CLI in `src/cli/weekly-review.ts` is the single entry point for the weekly run. Flags select the mode: `--dry-run`, `--stats-only`, `--show-last`, `--resolve`, `--force-clear-stale-lock`, or no flag for the full run. Helper modules under `src/cli/weekly-review/` handle individual concerns (lock, gather, baseline, prompt, agent, validation, digest, findings store, retention sweep, week window).

The full run flow is sequential and fail-fast: acquire the per-week lock by inserting an `agent_runs` row with `status='started'` (a partial unique index makes the second concurrent invocation fail on insert) → gather DB rows + live Slack thread transcripts → compute the deterministic SQL baseline → check the minimum-signal gate (skip LLM if plays<5 or votes<5) → build the prompt with past findings as context → call the Anthropic API with one retry on transient failure → validate every finding's `description` against quote/mention/transcript-substring rules → persist findings → format the Slack digest (baseline first, LLM section second) → post via existing `chat.postMessage` → run the retention sweep → mark the run `success`.

Transcript content is held in process memory only. A typed `Transcript` brand wrapper makes it impossible to pass transcripts into persistence/logging APIs at the type level; a CI test (`scripts/check-no-transcript-leakage.ts`) greps the run code for transcript field names appearing in DB write paths or log payloads as defense-in-depth.

Anthropic SDK (`@anthropic-ai/sdk`) is the project's first runtime dependency. Cost telemetry (input tokens, output tokens, estimated USD) is persisted on `agent_runs` from the API response's `usage` block.

## File Changes

### New Files

| File Path | Purpose |
|-----------|---------|
| `src/cli/weekly-review.ts` | CLI entry point. Flag parsing + mode dispatch. |
| `src/cli/weekly-review/types.ts` | Branded `Transcript` wrapper, `Finding`, `RuleArea`, `Severity`, `EvidenceStrength` types. |
| `src/cli/weekly-review/week-window.ts` | America/Chicago Sunday-to-Saturday window math. |
| `src/cli/weekly-review/lock.ts` | Acquire/release the per-week `started` row. |
| `src/cli/weekly-review/gather.ts` | DB joins + live Slack `conversations.replies` fetch + transcript token cap. |
| `src/cli/weekly-review/baseline.ts` | Deterministic SQL aggregations rendered as digest text. |
| `src/cli/weekly-review/rule-areas.ts` | Allow-list of `suspected_rule_area` identifiers + normalization. |
| `src/cli/weekly-review/prompt.ts` | System + user prompt builder with past findings + channel corrections. |
| `src/cli/weekly-review/agent.ts` | Anthropic SDK call, retry-once, cost telemetry. |
| `src/cli/weekly-review/validation.ts` | Reject findings with quotes / mentions / transcript-substring matches. |
| `src/cli/weekly-review/findings-store.ts` | `agent_runs` + `agent_findings` writes; retention sweep. |
| `src/cli/weekly-review/digest.ts` | Slack message formatter, ordering, truncation, empty/insufficient/error fallbacks. |
| `scripts/check-no-transcript-leakage.ts` | CI guard: grep for transcript fields in DB writes / log payloads. |
| `src/cli/weekly-review/__tests__/week-window.test.ts` | Window math edge cases. |
| `src/cli/weekly-review/__tests__/lock.test.ts` | Concurrent-run race + stale recovery. |
| `src/cli/weekly-review/__tests__/gather.test.ts` | DB joins, transcript fetch & truncation, exclusion filters. |
| `src/cli/weekly-review/__tests__/baseline.test.ts` | SQL aggregation correctness. |
| `src/cli/weekly-review/__tests__/prompt.test.ts` | Prompt structure, past findings inclusion, hard-rule presence. |
| `src/cli/weekly-review/__tests__/validation.test.ts` | Quote/mention/substring rejection. |
| `src/cli/weekly-review/__tests__/findings-store.test.ts` | Persistence + sweep idempotency. |
| `src/cli/weekly-review/__tests__/digest.test.ts` | Ordering, truncation, fallback messages. |
| `src/cli/weekly-review/__tests__/agent.test.ts` | Retry + cost telemetry (mocked SDK). |

### Modified Files

| File Path | Changes |
|-----------|---------|
| `src/storage/db.ts` | Add `agent_runs` and `agent_findings` tables in `createDatabase`. Insert the new `CREATE TABLE` statements **immediately after the `play_tags` block** (currently lines ~187–210 in `createDatabase`), then their indexes, before the existing index-creation tail. The partial unique index on `(week_starting) WHERE status='started'` is the lock mechanism. |
| `src/config.ts` | Add `anthropicApiKey` (required at run time, not load time), `agentModel` (default `claude-sonnet-4-6`), `agentHistoryWeeks` (default 8). |
| `package.json` | Add `@anthropic-ai/sdk` to a new top-level `"dependencies"` block (the project currently has only `"devDependencies"`; the dependencies key does not yet exist). Add scripts `weekly-review`, `check:leakage`. |

## Implementation Details

### Week window

**Pattern to follow**: `src/daemon/scheduler.ts` `formatDate`, `getTodayDate` for the local-time convention.

**Overview**: All week math is in `America/Chicago`. The default window is the most recent **complete** Sunday-through-Saturday week.

```typescript
// src/cli/weekly-review/week-window.ts

const TZ = "America/Chicago";

export interface WeekWindow {
  /** Inclusive Sunday in YYYY-MM-DD (Chicago local). */
  weekStarting: string;
  /** Inclusive Saturday in YYYY-MM-DD (Chicago local). */
  weekEnding: string;
}

export function defaultCompletedWeek(now: Date = new Date()): WeekWindow {
  // Convert `now` to America/Chicago wall clock, find the Saturday that ended
  // before today (or earlier), then walk back 6 days to its Sunday.
  // ...
}

export function explicitWeek(weekStartingYmd: string): WeekWindow {
  // Validate the input is a Sunday in Chicago; throw on malformed or non-Sunday input.
}
```

**Key decisions**:
- Use `Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", ... })` to map `Date` to Chicago wall clock without pulling in a date library. Bun has the IANA DB built in.
- "Most recent complete week" means: if today (Chicago) is Sunday, the window is two Sundays back; otherwise the window is the week ending the most recent Saturday.
- `--week-starting` must be a Sunday; non-Sunday input throws.

### Concurrent-run lock

**Pattern to follow**: existing `ON CONFLICT` SQL idiom in `slack-messages-store.ts`.

**Overview**: Insert into `agent_runs` with `status='started'`. The partial unique index `idx_agent_runs_started_lock ON agent_runs(week_starting) WHERE status='started'` ensures a second concurrent invocation fails on insert. Catch the `SQLITE_CONSTRAINT` and exit non-zero with a clear message.

```typescript
// src/cli/weekly-review/lock.ts

export interface LockHandle {
  runId: number;
  release(status: "success" | "error", errorText?: string): void;
}

export function acquireLock(
  db: Database,
  weekStarting: string,
  model: string,
): LockHandle {
  try {
    const result = db.prepare(`
      INSERT INTO agent_runs (week_starting, model, started_at, status)
      VALUES ($week, $model, datetime('now'), 'started')
      RETURNING id;
    `).get({ $week: weekStarting, $model: model }) as { id: number };

    return {
      runId: result.id,
      release: (status, errorText) => {
        db.prepare(`
          UPDATE agent_runs
          SET status = $status, completed_at = datetime('now'), error_text = $err
          WHERE id = $id;
        `).run({ $status: status, $err: errorText ?? null, $id: result.id });
      },
    };
  } catch (err) {
    if (isSqliteUniqueConstraintError(err)) {
      throw new ConcurrentRunError(weekStarting);
    }
    throw err;
  }
}

/**
 * bun:sqlite throws a plain Error on constraint violations. The discriminator
 * is `err.code`, a string like "SQLITE_CONSTRAINT_UNIQUE". There is no
 * dedicated error class to instanceof against. Encode the guard inline:
 */
function isSqliteUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

export function clearStaleLock(
  db: Database,
  weekStarting: string,
  olderThanHours = 1,
): number {
  const result = db.prepare(`
    DELETE FROM agent_runs
    WHERE week_starting = $week
      AND status = 'started'
      AND started_at < datetime('now', $offset);
  `).run({
    $week: weekStarting,
    $offset: `-${olderThanHours} hours`,
  });
  return Number(result.changes);
}
```

**Key decisions**:
- The lock row IS the run row. Same `id` is used through to `success` or `error`. Avoids a second table.
- `--force-clear-stale-lock` deletes `started` rows older than 1h. The deleted row's findings (if any) would be empty because the LLM call hadn't completed; deletion is safe.
- `ConcurrentRunError` carries the `week_starting` so the CLI can print "Another run is in progress for week X. Try `--force-clear-stale-lock` if you believe it's stuck."

### Data gather

**Pattern to follow**: `src/notifications/slack-messages-store.ts` for SQL helpers, `src/notifications/slack-client.ts` `callSlackApi` for the live fetch.

**Overview**: Three steps: query plays + snapshots + tags from DB, fetch transcripts from Slack, build the in-memory `Transcript` value.

```typescript
// src/cli/weekly-review/gather.ts

export interface GatheredData {
  window: WeekWindow;
  plays: GatheredPlay[];
  snapshots: VoteSnapshotRow[];
  tags: PlayTagRow[]; // empty array when phase 3 hasn't landed
  transcript: Transcript;
  channelCorrections: TranscriptMessage[]; // replies under prior digest messages
  priorFindings: FindingRow[]; // last AGENT_HISTORY_WEEKS weeks
  botUserId: string; // resolved once via auth.test
}

export async function gather(
  db: Database,
  config: SlackClientConfig,
  window: WeekWindow,
  historyWeeks: number,
  logger: Logger,
): Promise<GatheredData> {
  // 1. SQL gather (parameterized queries against window dates)
  // 2. Resolve bot_user_id via cached auth.test (or pass in from config)
  // 3. For each game in window with a slack_game_headers row, call
  //    conversations.replies via callSlackApi (use form encoding per the
  //    quirk in users.info; conversations.replies works with either, but
  //    form encoding is the safer default for read methods).
  // 4. Filter messages: drop any where user==botUserId, ts matches any
  //    prior posted_message_ts, or parent_ts matches any prior posted_message_ts
  //    (the third bucket goes into channelCorrections instead of being
  //    dropped silently).
  // 5. Per-game transcript token cap of 2000 (oldest-first truncation;
  //    annotate the truncated game with a `truncated: true` flag so the
  //    prompt builder can note it).
  // 6. priorFindings = SELECT FROM agent_findings JOIN agent_runs
  //    WHERE week_starting > datetime(window.weekStarting, '-' || $weeks || ' weeks')
}
```

**Key decisions**:
- `play_tags` query uses `LEFT JOIN` and tolerates the table not existing (catch the SQLite "no such table" error and return empty). When the table is present but the window has zero rows, return empty silently — both cases are the "phase 3 graceful degrade" path.
- Token cap uses a rough heuristic: 4 chars per token. Truncate from the start of the message list (oldest first) until the running estimate is ≤ 2000 tokens. Cheap; precision doesn't matter for context windows of 200k.
- Transcript fetch uses `conversations.replies` with `oldest`/`latest` parameters bracketing the game header's `ts` so we don't pull historical replies from older threads.

### Memory-only enforcement

**Pattern to follow**: TypeScript branded types (existing pattern: `FetchStatus` enum in `types/play.ts`).

**Overview**: A `Transcript` brand wrapper makes it a type error to pass transcripts into APIs that hit the DB or logger. The CI grep is defense-in-depth.

```typescript
// src/cli/weekly-review/types.ts

declare const TranscriptBrand: unique symbol;

export interface Transcript {
  readonly [TranscriptBrand]: never;
  readonly games: TranscriptGame[];
}

export interface TranscriptGame {
  readonly gamePk: number;
  readonly headerTs: string;
  readonly truncated: boolean;
  readonly messages: TranscriptMessage[];
}

export interface TranscriptMessage {
  readonly text: string;
  readonly user: string;
  readonly ts: string;
}

export function buildTranscript(games: TranscriptGame[]): Transcript {
  return { [TranscriptBrand]: undefined as never, games };
}
```

**Key decisions**:
- The `unique symbol` brand prevents structural typing from accepting any record-shaped object as a `Transcript`. Persistence and logging functions accept narrow types (`AgentRunRow`, `FindingRow`) that don't include `Transcript`.
- `TranscriptMessage.text` is read-only and only ever consumed by `prompt.ts` (which writes it into a string passed to the Anthropic SDK) and `validation.ts` (which uses it to detect verbatim copy in findings). Neither path leads to persistence or logging.
- Loggers must NEVER receive a `Transcript` value. Add a lint rule or rely on the CI grep below.
- **Known compile-time-only limitation**: the brand only protects against direct passing. `JSON.stringify(someObject)` where `someObject` happens to contain transcript fields will type-check and bypass the brand. The CI grep below explicitly targets `JSON.stringify` next to `db.prepare`, `logger.*`, and `chat.postMessage` to catch this.

```typescript
// scripts/check-no-transcript-leakage.ts

// Concrete patterns to match (regex, simple file-by-file):
//
// 1. Same-file colocation of "TranscriptMessage" or "TranscriptGame" with
//    any of: `db.run(`, `db.prepare(`, `logger.info(`, `logger.warn(`,
//    `logger.error(`, `chat.postMessage`, `chat.update`, `JSON.stringify`.
//    Reject the file unless the file is in __tests__/.
//
//    Example regex (run twice — once per ordering):
//      /TranscriptMessage[\s\S]{0,500}(db\.prepare|db\.run|logger\.(info|warn|error)|chat\.(postMessage|update)|JSON\.stringify)/
//      /(db\.prepare|db\.run|logger\.(info|warn|error)|chat\.(postMessage|update)|JSON\.stringify)[\s\S]{0,500}TranscriptMessage/
//
// 2. Field name "transcript" (whole word, case-insensitive) appearing
//    as an object-literal key in a `db.prepare(...).run({...})` chain:
//      /db\.prepare\([\s\S]+?\.run\(\s*\{[\s\S]+?\btranscript\b[\s\S]+?\}/i
//
// 3. The bare identifier `\.text` appearing as a value in a parameter
//    object passed to db.prepare().run() — too noisy to grep across the
//    repo, so this script restricts to src/cli/weekly-review/. False
//    positives here force the implementer to alias or rename the field.
//
// Exit non-zero on any match; exit 0 otherwise. Print the matching file
// and line number for each match so the implementer can investigate.
//
// Rules are deliberately simple regex with multi-line tolerance; false
// positives here are acceptable (the implementer can rename the field
// to bypass the matcher). False negatives are not — the privacy intent
// requires erring toward false-positive over false-negative.
```

**Implementation steps**:
1. Implement the CI script using `Bun.glob` + `Bun.file().text()` + simple regex.
2. Wire it into `package.json`: `"check:leakage": "bun run scripts/check-no-transcript-leakage.ts"`.
3. Document that the script must run as part of any CI pipeline before deploy. (Currently no CI exists per memory; this script exists as a manual `bun run check:leakage` until CI is added.)

### SQL baseline

**Overview**: Five fixed queries against `vote_snapshots` ⨝ `plays`, rendered as digest text.

```typescript
// src/cli/weekly-review/baseline.ts

export interface Baseline {
  totalPlays: number;
  playsWithVotes: number;
  flaggedCount: number;
  topPositive: { playId: number; netScore: number; description: string }[];
  topNegative: { playId: number; netScore: number; description: string }[];
  byTier: { tier: Tier; fireTotal: number; trashTotal: number }[];
  byPositionRunners: { position: string; runnersOn: string; fire: number; trash: number }[];
}

export function computeBaseline(db: Database, window: WeekWindow): Baseline {
  // Five SELECTs against vote_snapshots JOIN plays scoped to window.
  // Each query is short and parameterized; spec author writes the SQL.
}

export function renderBaselineForSlack(b: Baseline): string {
  // Compact mrkdwn, ≤5 lines. Top positive/negative shown only if non-empty.
}
```

**Key decisions**:
- The baseline runs against the same window the LLM sees, so the digest's two sections are consistent.
- `byPositionRunners` is the highest-leverage cross-dim slice — phase 5's whole reason to exist is finding patterns like "all the trash votes are on RF→Home with 1 runner on." Surface it deterministically so the operator can sanity-check the LLM.

### Rule-areas allow-list

**Overview**: The `suspected_rule_area` allow-list is grounded in real symbols in `src/detection/ranking.ts` (the `calculateTier` function) and `src/detection/detect.ts`. It must reflect what's actually tunable, not aspirational structure.

```typescript
// src/cli/weekly-review/rule-areas.ts

/**
 * Identifiers an LLM finding may map to. Each value points at a real,
 * tunable section of the detection logic — except for the two fallback
 * values (`new_tunable_needed`, `unknown`).
 *
 * When the bot's tier logic gains new factors (e.g., a runners_on weight
 * is added to ranking.ts), update this list. The agent's prompt
 * interpolates this list at build time, so no prompt change is needed
 * beyond the constant update.
 */
export const RULE_AREAS = [
  // ranking.ts (calculateTier)
  "ranking.ts:target_base_scores",   // Home=4, 3B=3, 2B=1
  "ranking.ts:direct_throw_bonus",   // segments.length === 2 → +2
  "ranking.ts:video_bonus",          // hasVideo → +1
  "ranking.ts:tier_thresholds",      // score >= 5 high, >= 3 medium, else low

  // detect.ts (detection eligibility)
  "detect.ts:outfield_codes",        // which positions count as OF
  "detect.ts:skip_events",           // event types excluded from detection

  // Fallbacks
  "new_tunable_needed",              // pattern points at a factor the bot doesn't currently consider (runners_on, outs, leverage)
  "unknown",                         // agent couldn't confidently map; flagged for prompt iteration
] as const;

export type RuleArea = (typeof RULE_AREAS)[number];

export function normalizeRuleArea(value: string, logger: Logger): RuleArea {
  if ((RULE_AREAS as readonly string[]).includes(value)) return value as RuleArea;
  logger.warn("agent returned unknown suspected_rule_area; normalizing to 'unknown'", { value });
  return "unknown";
}
```

**Key decisions**:
- `new_tunable_needed` is a deliberately distinct fallback from `unknown`. A pattern about runners_on isn't a hallucination — it's a real signal pointing at a factor the bot doesn't yet weight. The operator's action is "consider adding a tunable," not "consider changing one."
- `unknown` is reserved for cases where the agent couldn't articulate the factor at all. A high `unknown` rate over multiple weeks is the signal to refine the prompt.
- The list is small and hand-maintained. Adding a new entry requires updating this file (one place) plus shipping a code change that creates the actual tunable.

### Prompt builder

**Pattern to follow**: none yet in this codebase; this is the first LLM integration.

**Overview**: System prompt explains the bot, the goal, and the hard rules. User prompt is a structured payload of plays + votes + tags + transcripts + past findings + channel corrections.

```typescript
// src/cli/weekly-review/prompt.ts

export interface BuiltPrompt {
  system: string;
  user: string;
  estimatedInputTokens: number; // for the pre-call warn at 100k
}

export function buildPrompt(input: {
  window: WeekWindow;
  baseline: Baseline;
  plays: GatheredPlay[];
  snapshots: VoteSnapshotRow[];
  tags: PlayTagRow[];
  transcript: Transcript;
  channelCorrections: TranscriptMessage[];
  priorFindings: FindingRow[];
  ruleAreas: readonly string[];
}): BuiltPrompt {
  // ...
}
```

The system prompt MUST contain (verbatim or close to it):

```
You are reviewing the past week of an MLB outfield-assist bot's classifications.
The bot tiers each play (high/medium/low) using rules in src/detection/ranking.ts.
Channel members react :fire: (great play) or :wastebasket: (overrated / mis-detected).

Your job: identify SYSTEMATIC patterns covering 2+ plays — not per-play verdicts.
Per-play tier judgments are votes' job. Code-change suggestions are the operator's job.

Output discipline (HARD RULES):
1. Do NOT quote or paraphrase user comments.
2. Do NOT include Slack mentions, URLs, or user IDs.
3. Describe patterns abstractly. Example: "channel pushed back on RF→Home throws"
   is good. "User X said '<text>'" is FORBIDDEN.
4. Output is strictly JSON matching this schema; no prose outside it:
   { "findings": [
       { "finding_type": string,
         "description": string,         // 1-3 sentences, abstract only
         "severity": "info" | "watch" | "act",
         "evidence_strength": "weak" | "moderate" | "strong",
         "evidence_play_ids": number[],
         "suspected_rule_area": <one of allow-list>,
         "trend": "first_seen" | "recurring" | "escalating" | "cooling" | null
       }, ... ] }

Severity rules (single-run grounded):
- info: 2-3 plays, mixed/unclear signal
- watch: ≥4 plays, consistent directional signal
- act: clear majority disagreement with the classifier across affected plays

Evidence strength:
- weak: 2-3 plays
- moderate: 4-6 plays
- strong: 7+ plays

Allow-list for suspected_rule_area: {{rule_areas}}.
Use "unknown" if you cannot confidently map the pattern.
```

The user prompt sections (in order):
1. `## Window`: dates of the week.
2. `## Baseline`: rendered SQL summary.
3. `## Plays`: JSON array of each play with detected tier, fielder, position, runners_on, etc. — no transcripts here.
4. `## Vote snapshots`: per-play tallies.
5. `## Regex tags`: per-play tags from `play_tags` (omit section if empty).
6. `## Thread transcripts`: per-game blocks with `<truncated>` annotations where applicable.
7. `## Channel corrections`: replies under prior digest messages, labeled "weak signal — interpret cautiously."
8. `## Past findings (last N weeks)`: structured list of prior findings with their `outcome` so the agent can confirm/contradict.

**Key decisions**:
- Hard rules go in the system prompt (model-side priority) AND are echoed at the top of the user prompt (defense in depth).
- Past findings include `outcome` so the agent learns operator confirmations vs. rejections — this is the lightweight feedback loop without retraining.
- Allow-list values are interpolated into the system prompt at build time so the agent always sees the current allow-list.

### Anthropic API call

**Pattern to follow**: none in repo; this introduces `@anthropic-ai/sdk`.

**Overview**: Single `messages.create` call. One retry on transient failure. Persist `usage` block fields onto `agent_runs`.

```typescript
// src/cli/weekly-review/agent.ts

import Anthropic from "@anthropic-ai/sdk";

export interface AgentResult {
  rawFindings: unknown[]; // pre-validation
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export async function callAgent(
  apiKey: string,
  model: string,
  prompt: BuiltPrompt,
  logger: Logger,
): Promise<AgentResult> {
  const client = new Anthropic({ apiKey });

  if (prompt.estimatedInputTokens > 100_000) {
    logger.warn("agent prompt is large", { tokens: prompt.estimatedInputTokens });
  }

  const TIMEOUT_MS = 50_000;

  const attempt = async () => {
    // Wrap with a hard timeout so a hung TLS connection doesn't hold the lock
    // indefinitely. Stale-lock recovery is 1h; the timeout caps each attempt
    // well under that.
    return Promise.race([
      client.messages.create({
        model,
        max_tokens: 4096,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        temperature: 0,
      }),
      Bun.sleep(TIMEOUT_MS).then(() => {
        throw new AgentTimeoutError(`Anthropic call exceeded ${TIMEOUT_MS}ms`);
      }),
    ]);
  };

  let response;
  try {
    response = await attempt();
  } catch (err) {
    // A timeout is treated as transient — eligible for the single retry.
    if (isTransient(err) || err instanceof AgentTimeoutError) {
      logger.warn("agent call failed, retrying once", { error: String(err) });
      await Bun.sleep(5000);
      response = await attempt();
    } else {
      throw err;
    }
  }

  const text = extractTextBlock(response);
  const parsed = JSON.parse(text) as { findings: unknown[] };

  const usage = response.usage;
  const cost = estimateCost(model, usage.input_tokens, usage.output_tokens);
  if (cost > 1) {
    logger.warn("agent run exceeded cost ceiling", { estimatedCostUsd: cost });
  }

  return {
    rawFindings: parsed.findings ?? [],
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estimatedCostUsd: cost,
  };
}
```

**Key decisions**:
- `temperature: 0` for stability — pattern detection should be reproducible across re-runs of the same week.
- `isTransient` returns true for network errors, 429, 5xx, AND `AgentTimeoutError`; false for 4xx auth/permission errors. Hard-coded against the SDK's error classes.
- The 50s timeout is a hard cap per attempt. Worst-case wall-clock is ~105s (50s + 5s backoff + 50s retry) — well under stale-lock recovery's 1h.
- `estimateCost` uses model pricing constants kept in `agent.ts`. Update when Anthropic's prices change. (Acceptable: this is operator-internal telemetry, not billing.) Source-of-truth comment in `agent.ts` cites the Anthropic pricing page URL the implementer used at write time.
- JSON.parse failure escapes to the caller, which records `status='error'` via the lock release.

### Output validation

**Overview**: Three rejection rules per finding's `description`. Drop failing findings; log warns; continue with the rest. If all are dropped, post the SQL baseline plus a note.

```typescript
// src/cli/weekly-review/validation.ts

export interface ValidationResult {
  accepted: Finding[];
  rejected: { finding_type: string; reason: string }[];
}

export function validateFindings(
  raw: unknown[],
  transcript: Transcript,
  ruleAreas: readonly string[],
): ValidationResult {
  // 1. Shape check: each finding has all required fields with valid enum values.
  // 2. Description rules (REJECT on any match):
  //    a. Contains a quote character: " “ ” ' ‘ ’
  //    b. Contains Slack mention syntax: <@, <#, <!
  //    c. Contains a 30-char contiguous substring that also appears verbatim
  //       in any transcript message. Direction matters: slide a 30-char window
  //       OVER THE DESCRIPTION, then check whether the window appears in any
  //       transcript message text. Pseudocode:
  //         for offset in 0..(description.length - 30):
  //           window = description.substring(offset, offset + 30)
  //           if any transcript message includes(window): reject
  // 3. Normalize suspected_rule_area: if not in allow-list, set to 'unknown'
  //    and log warn (not a rejection — implementer's allow-list may lag agent).
  // 4. Validate evidence_play_ids are non-empty integers; otherwise reject.
}
```

**Key decisions**:
- Substring direction is description → transcript (slide a window over the description, look for matches in transcript messages). The reverse direction (window over each message, look in description) misses cases where the description quotes a fragment shorter than the message.
- Worst case complexity: with description length D and transcript total length T, the check is O(D × T / 30) using `String.includes`, which is acceptable for typical inputs (D ≤ a few hundred, T ≤ ~200k tokens × 4 chars = ~800k worst case — sub-second on a single LLM finding).
- Strip and re-test: don't normalize whitespace; quote characters are literal-character matches. False positives (legitimate mention of "the bot's classifier" failing because of an apostrophe) are caught and the implementer can refine. Default toward false positives; false negatives are the privacy risk.
- An invalid `suspected_rule_area` is normalized to `"unknown"` rather than rejecting the whole finding — this preserves the analytic value while flagging the prompt for refinement.

### Findings store

**Overview**: After validation, write the run's findings in a single transaction. The retention sweep runs as the last DB step before lock release.

```typescript
// src/cli/weekly-review/findings-store.ts

export function persistFindings(
  db: Database,
  runId: number,
  findings: Finding[],
): void {
  const insert = db.prepare(`
    INSERT INTO agent_findings (
      run_id, finding_type, description, severity, evidence_strength,
      evidence_play_ids, suspected_rule_area, trend
    ) VALUES (
      $runId, $type, $desc, $sev, $strength, $plays, $area, $trend
    );
  `);
  const tx = db.transaction(() => {
    for (const f of findings) insert.run({ /* ... */ });
  });
  tx();
}

export function recordAgentTelemetry(
  db: Database,
  runId: number,
  inputTokens: number,
  outputTokens: number,
  estimatedCostUsd: number,
  postedMessageTs: string | null,
): void {
  db.prepare(`
    UPDATE agent_runs
    SET input_tokens = $in, output_tokens = $out,
        estimated_cost_usd = $cost, posted_message_ts = $ts
    WHERE id = $runId;
  `).run({
    $in: inputTokens, $out: outputTokens,
    $cost: estimatedCostUsd, $ts: postedMessageTs, $runId: runId,
  });
}

export function runRetentionSweep(db: Database, weeks = 12): void {
  const cutoff = `-${weeks} weeks`;
  db.prepare(`
    UPDATE play_tags SET matched_text = NULL
    WHERE received_at < datetime('now', $cutoff);
  `).run({ $cutoff: cutoff });
  db.prepare(`
    UPDATE agent_findings SET description = NULL
    WHERE created_at < datetime('now', $cutoff);
  `).run({ $cutoff: cutoff });
}

export function autoCloseStaleFindings(db: Database, days = 14): void {
  // Findings older than `days` with outcome='pending' get auto-set to 'ignored'.
  db.prepare(`
    UPDATE agent_findings
    SET outcome = 'ignored', resolved_at = datetime('now')
    WHERE outcome = 'pending'
      AND created_at < datetime('now', $cutoff);
  `).run({ $cutoff: `-${days} days` });
}
```

**Key decisions**:
- Use a transaction for the findings inserts so partial writes can't leave the run with a half-populated set.
- The retention sweep targets BOTH `play_tags.matched_text` and `agent_findings.description` (FR-5.51, 5.52).
- Auto-close stale findings runs every full-run, using `datetime('now')` as the reference. This means a `--week-starting` replay does NOT delay auto-closure for findings created during the replayed week — they age based on wall-clock time, not the replayed week. Document this in the CLI help.
- The retention sweep is invoked from the full-run path AFTER findings persistence and BEFORE `lock.release('success')`. A sweep failure is logged at warn level but does NOT change the run status to `error` — the digest has already posted by that point. (See Error Handling table.)

### Slack digest

**Pattern to follow**: `src/notifications/slack-formatter.ts` block builders, but plain text is fine here — no need for blocks unless the operator prefers them.

**Overview**: Build a single mrkdwn-formatted message string. Order findings strictly. Truncate descriptions to 280 chars in the post (full text in DB).

```typescript
// src/cli/weekly-review/digest.ts

export function buildDigest(input: {
  window: WeekWindow;
  baseline: Baseline;
  findings: Finding[];
  hitRate: { confirmed: number; total: number };
  runId: number;
}): string {
  // Format per FR-5.48 in the PRD.
}

export function buildInsufficientDigest(window: WeekWindow, n: number, m: number): string {
  return `*Weekly classification review — week of ${window.weekStarting}*\n\nInsufficient data this week — ${n} plays, ${m} votes.`;
}

export function buildEmptyDigest(window: WeekWindow, baseline: Baseline, hitRate: HitRate): string {
  // SQL baseline + "No systematic patterns detected this week."
}

export function buildAllRejectedDigest(/* ... */): string {
  // SQL baseline + "LLM findings withheld this week — N findings failed output validation."
}

export function postDigest(
  config: SlackClientConfig,
  channel: string,
  message: string,
  logger: Logger,
): Promise<{ ts: string } | null> {
  // Wraps callSlackApi("chat.postMessage", { channel, text: message }, ...).
}
```

**Sort order**:
```typescript
function compareFindings(a: Finding, b: Finding): number {
  const sevOrder = { act: 0, watch: 1, info: 2 } as const;
  if (sevOrder[a.severity] !== sevOrder[b.severity]) {
    return sevOrder[a.severity] - sevOrder[b.severity];
  }
  const strengthOrder = { strong: 0, moderate: 1, weak: 2 } as const;
  if (strengthOrder[a.evidence_strength] !== strengthOrder[b.evidence_strength]) {
    return strengthOrder[a.evidence_strength] - strengthOrder[b.evidence_strength];
  }
  return b.evidence_play_ids.length - a.evidence_play_ids.length;
}
```

**Truncation**: each finding description is truncated to 280 chars + `…` for the Slack post. The DB row keeps the full text.

### CLI dispatcher

```typescript
// src/cli/weekly-review.ts

const FLAGS = parseArgs(Bun.argv.slice(2));
// { dryRun, statsOnly, showLast, resolve, forceClearStaleLock, weekStarting, minStrength }

// Defer ANTHROPIC_API_KEY validation until full-run is selected. --stats-only,
// --show-last, --dry-run, --resolve, --force-clear-stale-lock all run without it.
const config = loadConfig({ requireAnthropicKey: false });
const logger = createLogger(config.logLevel);
const db = createDatabase(config.dbPath);

try {
  if (FLAGS.showLast) await showLast(db);
  else if (FLAGS.resolve) await resolveFinding(db, FLAGS.resolve, logger);
  else if (FLAGS.forceClearStaleLock) await forceClearStaleLock(db, FLAGS.weekStarting, logger);
  else if (FLAGS.statsOnly) await runStatsOnly(db, config, logger, FLAGS.weekStarting);
  else if (FLAGS.dryRun) await runDryRun(db, config, logger, FLAGS.weekStarting);
  else {
    // Full-run path — Anthropic key is required here. Validate now.
    if (!config.anthropicApiKey) {
      throw new ConfigError("ANTHROPIC_API_KEY is required for the full run. Use --stats-only or --dry-run if intentional.");
    }
    await runFull(db, config, logger, FLAGS);
  }
} finally {
  db.close();
}
```

**Full-run scaffold (must structurally guarantee lock release):**

```typescript
async function runFull(db: Database, config: Config, logger: Logger, flags: Flags): Promise<void> {
  const window = flags.weekStarting
    ? explicitWeek(flags.weekStarting)
    : defaultCompletedWeek();

  const lock = acquireLock(db, window.weekStarting, config.agentModel);
  // From here through the finally block, EVERY exit path must run `lock.release(...)`.
  let releaseStatus: "success" | "error" = "error";
  let releaseError: string | undefined;
  try {
    const baseline = computeBaseline(db, window);
    const gathered = await gather(db, slackConfig(config), window, config.agentHistoryWeeks, logger);

    if (gathered.plays.length < 5 || totalVotes(gathered) < 5) {
      const ts = await postDigest(slackConfig(config), config.slackChannelId, buildInsufficientDigest(window, gathered.plays.length, totalVotes(gathered)), logger);
      recordAgentTelemetry(db, lock.runId, 0, 0, 0, ts?.ts ?? null);
      releaseStatus = "success";
      return;
    }

    const prompt = buildPrompt({ window, baseline, ...gathered, ruleAreas: RULE_AREAS });
    const agentResult = await callAgent(config.anthropicApiKey!, config.agentModel, prompt, logger);
    const validated = validateFindings(agentResult.rawFindings, gathered.transcript, RULE_AREAS);
    const ordered = orderFindings(validated.accepted).filter(byMinStrength(flags.minStrength));

    persistFindings(db, lock.runId, ordered);

    const hitRate = getHitRate(db);
    const message = ordered.length === 0
      ? (validated.rejected.length > 0
          ? buildAllRejectedDigest(window, baseline, hitRate, validated.rejected.length)
          : buildEmptyDigest(window, baseline, hitRate))
      : buildDigest({ window, baseline, findings: ordered, hitRate, runId: lock.runId });

    const ts = await postDigest(slackConfig(config), config.slackChannelId, message, logger);
    if (!ts) {
      releaseError = "slack post failed";
      return; // releaseStatus stays "error"
    }

    recordAgentTelemetry(db, lock.runId, agentResult.inputTokens, agentResult.outputTokens, agentResult.estimatedCostUsd, ts.ts);

    // Sweep BEFORE marking success. A sweep failure is logged as warn but does
    // NOT flip the status to error (the digest already posted).
    try {
      runRetentionSweep(db);
      autoCloseStaleFindings(db);
    } catch (err) {
      logger.warn("retention sweep failed", { error: String(err) });
    }

    releaseStatus = "success";
  } catch (err) {
    releaseError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    lock.release(releaseStatus, releaseError);
  }
}
```

**Stats-only scaffold**:

```typescript
async function runStatsOnly(
  db: Database,
  config: Config,
  logger: Logger,
  weekStarting?: string,
): Promise<void> {
  const window = weekStarting ? explicitWeek(weekStarting) : defaultCompletedWeek();

  // Acquire the lock even though we don't call the LLM — Slack post is
  // still irreversible, and stats-only must not race with full-run.
  const lock = acquireLock(db, window.weekStarting, "stats-only");
  let releaseStatus: "success" | "error" = "error";
  let releaseError: string | undefined;
  try {
    const baseline = computeBaseline(db, window);
    const baselineSlack = renderBaselineForSlack(baseline);
    const message = `*Weekly classification review (stats-only) — week of ${window.weekStarting} to ${window.weekEnding}*\n\n${baselineSlack}`;

    const ts = await postDigest(slackConfig(config), config.slackChannelId, message, logger);
    if (!ts) {
      releaseError = "slack post failed";
      return;
    }

    recordAgentTelemetry(db, lock.runId, 0, 0, 0, ts.ts);
    // No retention sweep on stats-only: it's a degraded run, not a full one.
    releaseStatus = "success";
  } catch (err) {
    releaseError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    lock.release(releaseStatus, releaseError);
  }
}
```

**Dry-run scaffold**:

```typescript
async function runDryRun(
  db: Database,
  config: Config,
  logger: Logger,
  weekStarting?: string,
): Promise<void> {
  // No lock — dry-run writes nothing.
  const window = weekStarting ? explicitWeek(weekStarting) : defaultCompletedWeek();
  const baseline = computeBaseline(db, window);
  const gathered = await gather(db, slackConfig(config), window, config.agentHistoryWeeks, logger);
  const prompt = buildPrompt({ window, baseline, ...gathered, ruleAreas: RULE_AREAS });

  console.log("=== SYSTEM PROMPT ===\n");
  console.log(prompt.system);
  console.log("\n=== USER PROMPT ===\n");
  console.log(prompt.user);
  console.log(`\n=== ESTIMATED INPUT TOKENS: ${prompt.estimatedInputTokens} ===`);

  // FR-5.4: dry-run prints the parsed agent response too — but only when
  // the API key is available. Without it, just print the prompt.
  if (!config.anthropicApiKey) {
    console.log("\n=== ANTHROPIC_API_KEY not set; skipping LLM call ===");
    return;
  }

  console.log("\n=== AGENT RESPONSE (calling LLM, no DB or Slack writes) ===\n");
  const result = await callAgent(config.anthropicApiKey, config.agentModel, prompt, logger);
  const validated = validateFindings(result.rawFindings, gathered.transcript, RULE_AREAS);
  console.log(JSON.stringify({
    accepted: validated.accepted,
    rejected: validated.rejected,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
  }, null, 2));
}
```

**Key decisions for the alternate paths**:
- Stats-only acquires the lock so concurrent runs (full + stats-only against the same week) don't both post to Slack. This is the same hygiene as full-run; the only thing skipped is the LLM call, validation, and findings persistence.
- Dry-run does NOT acquire the lock. It writes nothing, posts nothing, and is safe to run concurrently with anything else. Two dry-runs in parallel just both print to stdout.
- Both modes still call `gather()`, which hits the Slack API for transcripts. There's no "fully offline" mode in v1; if the operator wants offline preview, they can edit `gather.ts` to load fixture data — out of scope for the ship.

**Exit codes**:
- 0 — success or no-op (stats-only with empty week, etc.)
- 1 — runtime error (LLM failure after retry, Slack post failure, etc.)
- 2 — concurrent run detected (lock acquisition failed)
- 3 — bad CLI input (invalid `--week-starting`, malformed `--resolve` args, missing `ANTHROPIC_API_KEY` on the full-run path)

**`--resolve` syntax**: `bun run weekly-review --resolve <run_id> <finding_id> <confirmed|rejected>`. Updates `agent_findings.outcome`, sets `resolved_at = datetime('now')`, and writes `resolved_by_run_id = (SELECT MAX(id) FROM agent_runs WHERE status = 'success')`. If no successful run exists yet (edge case for the very first finding being resolved during a manual session), `resolved_by_run_id` is left NULL.

**`--min-strength` flag**: optional, values `weak` | `moderate` | `strong`. When set, drops findings below the threshold before persistence (per FR-5.38). Default is `weak` (no filtering). Filtering is applied in the full-run scaffold above via `byMinStrength(flags.minStrength)` AFTER validation but BEFORE persistence — a `weak` finding the operator chose to filter out is not in `agent_findings`, so it doesn't land in the trust-calibration hit rate either.

### Trust calibration

The full-run flow appends a hit-rate footer to the Slack digest:

```typescript
// src/cli/weekly-review/findings-store.ts

export function getHitRate(db: Database, weeks = 8): { confirmed: number; total: number } {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN outcome = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN outcome IN ('confirmed', 'rejected') THEN 1 ELSE 0 END) AS resolved
    FROM agent_findings f
    JOIN agent_runs r ON r.id = f.run_id
    WHERE r.week_starting > datetime('now', $cutoff);
  `).get({ $cutoff: `-${weeks} weeks` }) as { confirmed: number | null; resolved: number | null };
  return {
    confirmed: row.confirmed ?? 0,
    total: row.resolved ?? 0,
  };
}
```

The footer line: `hit rate over last 8 weeks: X/Y findings confirmed`. When `total < 5`, render: `hit rate: insufficient data (Y resolved so far) — resolve findings via --resolve`. The 5-resolved floor matches FR-5.18's minimum-signal gate philosophy: a 1/1 = 100% hit rate from a single resolution is meaningless; require at least 5 resolved findings before the percentage carries any signal.

## Data Model

### Schema additions (`src/storage/db.ts` `createDatabase`)

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  week_starting       TEXT NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_started_lock
  ON agent_runs(week_starting) WHERE status = 'started';

CREATE TABLE IF NOT EXISTS agent_findings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                INTEGER NOT NULL REFERENCES agent_runs(id),
  finding_type          TEXT NOT NULL,
  description           TEXT,
  severity              TEXT NOT NULL CHECK (severity IN ('info', 'watch', 'act')),
  evidence_strength     TEXT NOT NULL CHECK (evidence_strength IN ('weak', 'moderate', 'strong')),
  evidence_play_ids     TEXT NOT NULL,
  suspected_rule_area   TEXT NOT NULL,
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

`description` is nullable here (not in PRD) because the retention sweep nulls it after 12 weeks.

## Testing Requirements

### Unit Tests

| Test File | Coverage |
|-----------|----------|
| `week-window.test.ts` | Sunday detection, Saturday rollover, mid-week default, DST boundaries (US-Central transitions), explicit invalid input. |
| `lock.test.ts` | First acquire returns runId. Second concurrent acquire throws ConcurrentRunError. Release flips status. clearStaleLock deletes >1h old started rows, leaves fresh ones. |
| `gather.test.ts` | DB join correctness across plays/snapshots/tags/headers. Transcript fetch (mocked fetch) filters bot user. Filters digest ts. Routes digest replies into channelCorrections. Token cap truncates oldest first. Empty `play_tags` table tolerated. |
| `baseline.test.ts` | Each of the 5 aggregations against seeded data. Empty week renders zero baseline lines. |
| `prompt.test.ts` | System prompt contains all hard rules. User prompt contains all sections in order. Allow-list interpolated. Past findings limited to historyWeeks. Channel corrections labeled. |
| `validation.test.ts` | Quote rejection. Mention rejection. Substring match rejection. Shape rejection (missing field). Allow-list miss → normalized to 'unknown', not rejected. |
| `findings-store.test.ts` | persistFindings inserts in transaction. recordAgentTelemetry updates. Retention sweep nulls both tables' prose columns. autoCloseStaleFindings idempotent. getHitRate handles empty / partial data. |
| `digest.test.ts` | Sort order correct. Truncation at 280. Insufficient/empty/all-rejected fallbacks render correctly. Empty findings still post the baseline. |
| `agent.test.ts` | Single call success path. Transient error → one retry. Non-transient error → no retry, throws. Cost telemetry computed. Pre-call warn at 100k. Post-call warn at $1. |

**Key test cases**:
- Window: today=Wednesday → window = prior Sunday-Saturday. today=Sunday → window = two Sundays back. DST start (March): make sure midnight Sunday Chicago math doesn't slip a day.
- Lock: race two synchronous calls — second throws. After release, third acquire works.
- Gather: feed in 5 transcript messages totaling 8000 chars (~2000 tokens) → no truncation. Same with 12000 chars → oldest 4 dropped.
- Validation: a finding description containing the literal string `"player ran"` (matching a transcript) is rejected.
- Validation: a finding with `suspected_rule_area: "ranking.ts:not_in_list"` is normalized to `"unknown"` and a warn is logged, but the finding is still accepted.

### Integration Tests

| Test File | Coverage |
|-----------|----------|
| `weekly-review.integration.test.ts` | Spin up `:memory:` DB seeded with a week of plays + snapshots + slack_play_messages. Mock `globalThis.fetch` to dispatch by URL: `conversations.replies` → canned thread payload; `chat.postMessage` → success; `api.anthropic.com/v1/messages` → canned findings JSON. **Pattern to follow**: `src/server/__tests__/routes.test.ts` (see the `globalThis.fetch = mock(async (input) => { ... if (url.includes('users.info')) { ... } })` block and the `originalFetch` save/restore in `afterEach`). Run the full CLI in `--week-starting` mode against this fixture. Assert: lock row created+released, findings persisted, Slack post issued, retention sweep ran. |

### CI / Static Analysis

- `bun run check:leakage` exits 0. Add a deliberately-broken commit to verify the script catches it (in tests, not in main).

### Manual Testing

> **No test channel exists.** Manual testing happens against the live production channel and DB. The dry-run path is the primary safety net.

**Pre-deploy (local only):**
- [ ] Run `bun test` with broad coverage including the integration test.
- [ ] `bun run check:leakage` clean.
- [ ] `bun run weekly-review --dry-run --week-starting <past-Sunday>` against a copy of prod DB. Inspect the printed prompt for: hard rules present, allow-list interpolated, transcripts truncated where expected, no PII in baseline.

**Post-deploy:**
- [ ] `bun run weekly-review --stats-only --week-starting <past-Sunday>` posts a baseline-only digest. Verify in Slack the post arrives, no LLM mention.
- [ ] `bun run weekly-review --week-starting <past-Sunday>` against the prior complete week. Watch for: `agent_runs` row transitions started→success, `agent_findings` rows created, Slack post arrives with baseline + LLM section, hit-rate footer renders "insufficient data" on first run.
- [ ] Resolve at least one finding via `--resolve`. Run the next week's review and confirm the hit-rate footer reflects the resolution.
- [ ] Concurrent-run sanity: in two SSH sessions, run `bun run weekly-review` simultaneously. One succeeds, one exits with code 2.
- [ ] Force-clear: kill a run mid-flight (ctrl-c the bun process). Confirm the next run reports "Another run is in progress" until 1h passes. Use `--force-clear-stale-lock` to recover sooner.

## API Design

### New CLI Surface

| Command | Description |
|---------|-------------|
| `bun run weekly-review` | Full run for the most recent complete week. |
| `bun run weekly-review --week-starting YYYY-MM-DD` | Replay/backfill a specific week. |
| `bun run weekly-review --dry-run [--week-starting ...]` | Print prompt, no LLM/Slack/DB. |
| `bun run weekly-review --stats-only [--week-starting ...]` | Baseline-only digest, no LLM call. |
| `bun run weekly-review --show-last` | Print the most recent run's findings to stdout. |
| `bun run weekly-review --resolve <run_id> <finding_id> <confirmed\|rejected>` | Update a finding's outcome. |
| `bun run weekly-review --force-clear-stale-lock --week-starting ...` | Delete stuck `started` rows >1h old. |

### External APIs Consumed

| API | Method | Encoding |
|-----|--------|----------|
| Slack Web API | `conversations.replies` | form (per the read-method quirk) |
| Slack Web API | `chat.postMessage` | json (existing) |
| Slack Web API | `auth.test` | json (existing) |
| Anthropic Messages | `messages.create` | json (SDK handles) |

## Error Handling

| Error Scenario | Handling Strategy |
|----------------|-------------------|
| `ANTHROPIC_API_KEY` missing in non-stats-only mode | Throw on config load with a clear message. Exit code 3. |
| Concurrent run already in `started` for the week | Throw `ConcurrentRunError`. Exit code 2. Suggest `--force-clear-stale-lock`. |
| Slack `conversations.replies` fails for a single game | Log warn, exclude that game's transcript from the bundle, continue. |
| Anthropic call fails (transient) | One retry after 5s. |
| Anthropic call fails (non-transient) or after retry | Mark run `error`, do not post Slack, exit code 1. |
| Anthropic returns malformed JSON | Mark run `error`, log raw response (NOT to Slack), exit code 1. |
| All findings fail validation | Post the SQL baseline + "LLM findings withheld" line. Mark run `success` (the run completed; the LLM was just unhelpful). |
| Slack `chat.postMessage` fails | Mark run `error`, retain findings in DB so a manual re-post via `--show-last` is possible, exit code 1. |
| Retention sweep fails | Log warn, do NOT mark the run as error — the digest already posted. Operator can retry sweep manually. |

## Validation Commands

```bash
bun run typecheck
bun run check:leakage
bun test
bun run weekly-review --dry-run --week-starting <last-completed-Sunday>
```

## Rollout Considerations

- **Trust calibration is the rollout gate.** Ship the CLI as `--stats-only`-default for the first 1-2 weeks; flip to full run only after operator confirms the baseline numbers feel right.
- **First full run is hand-triggered Sunday morning.** Watch the run end-to-end; verify Slack post, confirm at least one finding via `--resolve`.
- **Cron promotion**: do not set up cron until 8 weeks of data show ≥50% confirmed rate. Even then, OS-level cron on the VM, not a daemon peer task.
- **Cost monitoring**: `SELECT week_starting, estimated_cost_usd FROM agent_runs ORDER BY week_starting DESC LIMIT 12;` should run cleanly at <$1/week. If a run exceeds, the warn fires; investigate before the next.
- **Privacy posture**: the deploy ships with no chat content in DB beyond `play_tags.matched_text` (regex matches, capped at 12 weeks) and `agent_findings.description` (validated abstract patterns, capped at 12 weeks). Verify after first run via:
  ```sql
  SELECT description FROM agent_findings WHERE description LIKE '%"%' OR description LIKE '%<@%';
  -- Should return zero rows.
  ```
- **Rollback plan**:
  1. Fastest: stop running the CLI. The schema additions are inert when nothing writes to them.
  2. Code rollback: revert the deploy. `agent_runs` and `agent_findings` tables remain in DB harmlessly.
  3. Data rollback: not applicable; the run does not mutate phase-1/2/3/4 tables. The retention sweep on `play_tags.matched_text` is irreversible (it nulls a column) but only affects rows >12 weeks old, which were already past the privacy-sensitive horizon.

## Open Items

- [ ] Decide whether the CI grep script needs to be wired into a real CI pipeline now (currently the project has none) or run manually as part of the deploy checklist. Lean toward manual until the project picks up CI.
- [ ] Decide whether `--show-last` should also accept `--week-starting` to view a specific run's findings, or just always show the latest. Spec implementer's call.
- [ ] Pricing constants for `estimateCost` need to track Anthropic's price changes. Document the source-of-truth comment in `agent.ts`.

---

*This spec is ready for implementation. Follow the patterns and validate at each step.*
