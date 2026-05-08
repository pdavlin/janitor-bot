# PRD: operator-dm-notifications - Phase 1

**Contract**: ./contract.md
**Phase**: 1 of 1
**Focus**: Generic operator-notify helper plus four trigger-site wirings in the weekly-review flow.

## Phase Overview

Single shippable phase. The scope is small enough that splitting would add ceremony without value: one helper module, one env var, four call sites, all in `src/cli/weekly-review/`. The phase delivers the full operator-DM workflow promised in the contract.

## User Stories

1. As the operator, I want a Slack DM when a weekly-review full run captures a `--dump` file, so I know to inspect the eval artifact instead of relying on memory to ssh in and check.
2. As the operator, I want a Slack DM when a second concurrent weekly-review run is blocked, so I know to investigate (e.g. did the prior run hang?) instead of finding out hours later by accident.
3. As the operator, I want a Slack DM when the retention sweep fails, so I can fix the underlying issue (corrupt index, disk full) before the next run.
4. As the operator, I want a Slack DM when every LLM finding fails validation in a single run, so I know the prompt may need iteration even though the digest still posts a baseline.
5. As the operator, I want notifications to be safely degraded — a missing `OPERATOR_USER_ID` env var or a transient Slack failure must never break the underlying run.

## Functional Requirements

### Configuration

- **FR-1.1**: Add `OPERATOR_USER_ID` to env. Read in `loadConfig()` as `operatorUserId: string | undefined`.
- **FR-1.2**: When `OPERATOR_USER_ID` is unset, the bot logs one warn at process startup (per CLI invocation that would otherwise send a notification) and all `notifyOperator` calls become no-ops. No errors, no exit-code changes.
- **FR-1.3**: When set, the value MUST look like a Slack user_id (starts with `U` or `W`, all uppercase, alphanumeric). Reject malformed values at config load time with a clear error message.

### Helper

- **FR-1.4**: New module `src/cli/weekly-review/notify-operator.ts` exporting `notifyOperator(slackConfig, userId, body, logger)`.
- **FR-1.5**: The helper calls `chat.postMessage` with `channel = userId`. Slack treats this as posting to the user's IM. No new scope is expected; `chat:write` (already configured) covers it.
- **FR-1.6**: The helper accepts a structured `body: { kind: NotificationKind; ctx: ... }` shape rather than a raw string. The kind drives a stable subject prefix (e.g. `:floppy_disk: Dump captured`) so DMs are scannable in the operator's Slack feed.
- **FR-1.7**: `NotificationKind` is a closed union: `"dump_captured" | "concurrent_run_blocked" | "retention_sweep_failed" | "all_findings_rejected"`.
- **FR-1.8**: Failure modes (HTTP error, non-ok response, network) are logged at `warn` level with the kind and the cause; the helper returns `false` and never throws.
- **FR-1.9**: Successful sends return `true` and log at `debug` (not `info`) so the channel digest post remains the dominant log signal.

### Body Content (privacy-aware)

- **FR-1.10**: All DM bodies MUST pass the same description rules the validated findings already meet (no quote characters, no Slack mention syntax, no transcript content). Defense-in-depth for the operator-DM transport.
- **FR-1.11**: `dump_captured` body includes: week window, run id, model, dump file path, accepted-finding count, rejected-finding count, total cost. NO finding descriptions in the DM body — the operator opens the dump file or the channel digest for those.
- **FR-1.12**: `concurrent_run_blocked` body includes: blocked week, the conflicting run id (from the existing `agent_runs` row), and the suggested recovery (`--force-clear-stale-lock`).
- **FR-1.13**: `retention_sweep_failed` body includes: the run id whose post-run sweep failed and the error message (truncated to 280 chars).
- **FR-1.14**: `all_findings_rejected` body includes: the run id, the rejection count, and the rejection reasons grouped by reason (e.g. `quote: 3, mention: 1, substring: 1`). Reason strings already come from the validator and are abstract.

### Trigger Sites

- **FR-1.15**: In `runFull` after a successful dump write, call `notifyOperator` with `dump_captured`. The dump path returned by `writeDump` is the link.
- **FR-1.16**: In `runFull` (and `runStatsOnly`) when `acquireLock` throws `ConcurrentRunError`, call `notifyOperator` with `concurrent_run_blocked` BEFORE returning exit code 2. The notification fires regardless of `--dump` flag.
- **FR-1.17**: In `runFull` when the retention sweep `try`/`catch` block catches an error, call `notifyOperator` with `retention_sweep_failed` from inside the catch block. Continues current behavior of marking the run `success` (digest already posted).
- **FR-1.18**: In `runFull` when `validated.accepted.length === 0 && validated.rejected.length > 0` (the all-rejected branch that triggers `buildAllRejectedDigest`), call `notifyOperator` with `all_findings_rejected` after the digest posts.

### Excluded triggers

- **FR-1.19**: The `--dry-run` and `--stats-only` paths do NOT trigger `dump_captured` notifications. Dry-runs are operator-driven and already print stdout; stats-only doesn't write a dump.
- **FR-1.20**: The minimum-signal-gate path (insufficient plays/votes) does NOT trigger `all_findings_rejected`. Those are distinct outcomes and the gate's "Insufficient data" channel post is sufficient.

### Failure isolation

- **FR-1.21**: A `notifyOperator` failure inside any trigger site MUST NOT change the run's exit code, lock-release status, or DB state. Each trigger site wraps the call in its own try/catch (or relies on the helper's swallowed-failure contract from FR-1.8).
- **FR-1.22**: A `notifyOperator` failure for `concurrent_run_blocked` specifically must not turn into a recursive lock-acquire (the failure path already exits with code 2; the DM is best-effort on top).

## Non-Functional Requirements

- **NFR-1.1**: All Slack API calls reuse the existing `callSlackApi` helper (which already handles rate-limit logging, content-type, and ok/error parsing). No duplicate request plumbing.
- **NFR-1.2**: The helper is unit-tested with a mocked fetch. Each `NotificationKind` body shape has a regression test that verifies the constructed Slack body matches the expected text.
- **NFR-1.3**: No transcript field names appear anywhere in `notify-operator.ts`. The leakage check should pass without the file needing the `transcript-leakage-allowed` marker.
- **NFR-1.4**: `OPERATOR_USER_ID` is treated as workspace-internal. It must NOT appear in any logged message body, error message, or Slack post.
- **NFR-1.5**: Total added latency on the full-run path must be under 1 second when the DM succeeds.

## Schema Changes

None.

## Dependencies

### Prerequisites

- Operator's Slack user_id captured in deploy `.env` as `OPERATOR_USER_ID=U...`.

### Outputs for Future Phases

- A reusable `notifyOperator` helper for any future operator-actionable event.

## Acceptance Criteria

- [ ] `bun test` passes including new tests for the helper, body builders, and trigger-site wiring.
- [ ] `bun run check` passes.
- [ ] `bun run check:leakage` passes; `notify-operator.ts` requires no allow marker.
- [ ] With `OPERATOR_USER_ID=U...` set, a full-run with `--dump` produces a Slack DM containing week, run id, dump path, accepted/rejected counts, and cost — and zero finding descriptions or transcript content.
- [ ] With `OPERATOR_USER_ID` unset, a full-run completes successfully and emits exactly one warn at startup; no DM is attempted, no errors are logged.
- [ ] Two parallel `weekly-review` invocations against the same week: the second exits with code 2 AND a DM lands within 5 seconds.
- [ ] A simulated retention-sweep failure results in the run reaching `success` AND a DM landing.
- [ ] A simulated all-rejected response results in the digest posting to channel AND a DM landing.
- [ ] Disabling Slack entirely does not cause `notifyOperator` to throw; the helper short-circuits and returns false.
- [ ] An invalid `OPERATOR_USER_ID` value fails at config load with a clear error before any work begins.
