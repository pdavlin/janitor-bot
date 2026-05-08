# Implementation Spec: operator-dm-notifications - Phase 1

**PRD**: ./prd-phase-1.md
**Estimated Effort**: S

## Technical Approach

A new `src/cli/weekly-review/notify-operator.ts` module exports a closed `NotificationKind` union with per-kind body builders, plus a single `notifyOperator(slackConfig, userId, body, logger)` function that delegates to the existing `callSlackApi` for transport. Slack accepts `chat.postMessage` with the user's `U...` id as the `channel` parameter (`chat:write` scope already configured covers it).

The helper is best-effort. `OPERATOR_USER_ID` is read in `loadConfig` and validated at startup. Trigger sites in `weekly-review.ts` call the helper inside their existing flow; failure cannot flow back into exit code, lock state, or DB writes.

`writeRunDump` currently returns `void`; spec changes it to `Promise<string | null>` so the dump-captured trigger has the path.

## File Changes

### New Files

| Path | Purpose |
|---|---|
| `src/cli/weekly-review/notify-operator.ts` | Helper module: `NotificationKind`, body builders, `notifyOperator`. |
| `src/cli/weekly-review/__tests__/notify-operator.test.ts` | Unit tests. |

### Modified Files

| Path | Changes |
|---|---|
| `src/config.ts` | Add `operatorUserId: string \| undefined`; read + validate `OPERATOR_USER_ID`. |
| `src/cli/weekly-review.ts` | Wire four trigger sites; change `writeRunDump` return type to `Promise<string \| null>`. |
| `src/cli/weekly-review/__tests__/weekly-review.integration.test.ts` | Extend to cover dump_captured + concurrent_run_blocked DM paths. |
| `src/daemon/__tests__/scheduler.test.ts` | Add `operatorUserId: undefined` to `makeTestConfig`. |

## Implementation Details

### Config

Pattern: existing `MIN_TIER` validation in `src/config.ts`.

```typescript
const OPERATOR_USER_ID_PATTERN = /^[UW][A-Z0-9]{8,}$/;

const rawOperatorUserId = process.env.OPERATOR_USER_ID;
let operatorUserId: string | undefined;
if (rawOperatorUserId !== undefined && rawOperatorUserId !== "") {
  if (!OPERATOR_USER_ID_PATTERN.test(rawOperatorUserId)) {
    throw new Error(
      `Invalid OPERATOR_USER_ID: "${rawOperatorUserId}". Expected a Slack user_id (e.g. "U07ABC1234").`,
    );
  }
  operatorUserId = rawOperatorUserId;
}
```

### Helper module

```typescript
// src/cli/weekly-review/notify-operator.ts

export type NotificationKind =
  | "dump_captured"
  | "concurrent_run_blocked"
  | "retention_sweep_failed"
  | "all_findings_rejected";

const KIND_PREFIX: Record<NotificationKind, string> = {
  dump_captured: ":floppy_disk: Weekly-review dump captured",
  concurrent_run_blocked: ":lock: Concurrent weekly-review blocked",
  retention_sweep_failed: ":warning: Retention sweep failed",
  all_findings_rejected: ":no_entry_sign: All LLM findings rejected",
};
```

Per-kind context interfaces and `bodyLines(body: NotificationBody)` switch (exhaustive). `renderNotification(body)` joins prefix + lines. `notifyOperator(slackConfig, userId, body, logger)` short-circuits on missing userId or botToken, calls `callSlackApi`, swallows errors with warn log.

### Trigger sites

1. **dump_captured**: in `runFull` after `writeRunDump` returns a non-null path, call `notifyOperator` with the path + counts + cost.
2. **concurrent_run_blocked**: in the `ConcurrentRunError` catch in `runFull` AND `runStatsOnly`, look up the blocking run id via `SELECT id FROM agent_runs WHERE week_starting=$week AND status='started' LIMIT 1` (wrap in try/catch — DB may be locked), then notify before returning 2.
3. **retention_sweep_failed**: inside the existing sweep catch, after the warn log, fire the DM.
4. **all_findings_rejected**: in `runFull` when `ordered.length === 0 && validated.rejected.length > 0`, after `postDigest` succeeds, group rejections via `simplifyReason` (private helper that maps long validation reasons to short keys: `quote`, `mention`, `substring`, `shape`, `other`) and fire the DM.

Each trigger site relies on the helper's swallowed-failure contract; no extra try/catch needed at the call sites.

## Testing Requirements

### Unit Tests

`__tests__/notify-operator.test.ts`:
- `renderNotification` for each `NotificationKind` produces expected text (week, run id, path, etc.).
- `renderNotification(retention_sweep_failed)` truncates error messages > 280 chars.
- `renderNotification(all_findings_rejected)` groups + sorts reasons.
- `notifyOperator` happy path with mocked fetch.
- `notifyOperator` returns false on Slack non-ok / network throw / empty userId / missing botToken.

### Integration Tests

Extend `weekly-review.integration.test.ts`:
- Full run with `--dump` and `OPERATOR_USER_ID` set → mocked fetch sees a `chat.postMessage` to the user_id.
- Full run with `--dump` but `OPERATOR_USER_ID` unset → no DM.
- Lock conflict → DM fires with `concurrent_run_blocked` body.

### CI

- `bun run check` clean.
- `bun run check:leakage` clean (helper does not need allow marker).

## Validation Commands

```bash
bun run check
bun test
bun run check:leakage
```

## Rollout Considerations

- Rollback: unset `OPERATOR_USER_ID` and restart. All notification paths short-circuit.
- Privacy: body builders are pure-string constructions over structured inputs. Run `grep -E '<@|"|"|"' <captured-message>` post-deploy to confirm.
- Future kinds: extend `NotificationKind` union, add prefix entry, add body case (compiler enforces exhaustiveness).

---

*Ready for implementation.*
