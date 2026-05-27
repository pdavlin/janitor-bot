# Implementation Spec: rematch-agent - Phase 1

**PRD**: ./prd-phase-1.md
**Estimated Effort**: S

## Technical Approach

Build a single, mockable function `rematchVideo` in `src/detection/rematch-agent.ts`. It wraps the existing `callAgent` infrastructure from `src/cli/weekly-review/agent.ts` (which already handles timeouts, retries, cost caps, and tool-use loops) using one tool: `pick_video`.

`callAgent` today returns `AgentResult` with `rawFindings: unknown[]` — that shape is wrong for re-match. Two options:

1. **Wrap `callAgent` and re-parse the final tool call**: requires a small refactor of `callAgent` to expose tool-call results before they're consumed by the JSON finalizer, OR teach the loop to skip the JSON-payload parsing when the tool's `result` is itself the answer.
2. **Sidestep `callAgent` and reuse only the lower-level Anthropic client + tool-loop pattern**: copy the timeout/retry/cost-cap machinery into a thinner helper specific to re-match, where the agent's `pick_video` tool input *is* the result and the loop terminates after the first call.

Option 2 is cleaner: the re-match use case is structurally different from the weekly-review use case (single mandatory tool call, no JSON parsing of final text). Trying to overload `callAgent`'s return shape with another mode adds complexity for both call sites. Copy the small amount of timeout/retry logic into the new module; the AgentClient interface and `estimateCost` are exported and reusable.

Decision: **Option 2**. New module imports `AgentClient`, `defaultClient`, `estimateCost`, `AgentTimeoutError`, `AgentResponseError` from the existing agent.ts (export what's not already exported), and runs its own minimal loop.

## File Changes

### New Files

| File Path | Purpose |
|-----------|---------|
| `src/detection/rematch-agent.ts` | Exports `rematchVideo`, the `RematchInput`/`RematchResult` types, and an injectable `AgentClient`. |
| `src/detection/__tests__/rematch-agent.test.ts` | Unit tests covering all decision paths and failure modes with a mocked `AgentClient`. |

### Modified Files

| File Path | Changes |
|-----------|---------|
| `src/cli/weekly-review/agent.ts` | Export `defaultClient` (currently unexported) so the new module can share it. No behavior change. |
| `src/config.ts` | Add `rematchAgentModel` field; default to the same model the weekly-review agent uses (`claude-sonnet-4-6`). Wire from env if a relevant var already exists. |

## Implementation Details

### `RematchInput` / `RematchResult` types

**Overview**: Discriminated union for the agent's three possible outcomes. The input shape mirrors the candidate shape used by the existing heuristic so callers don't translate twice.

```typescript
// src/detection/rematch-agent.ts

export interface RematchCandidate {
  /** Stable id from the MLB content API highlight item. */
  id: string;
  /** The free-text description the agent reads to pick. */
  description: string;
  /** Optional title; passed through for logging only. */
  title?: string;
}

export interface RematchInput {
  /** MLB play description text (`plays.description`). */
  playDescription: string;
  /** id of the currently displayed video, or null when first pass found nothing. */
  currentVideoId: string | null;
  /** Full game video list; the agent picks one of these by id. */
  candidates: RematchCandidate[];
  /** For logging only. */
  gamePk: number;
}

export type RematchResult =
  | { decision: "swapped"; videoId: string; reason?: string }
  | { decision: "agreed"; reason?: string }
  | { decision: "no_match"; reason?: string };
```

**Key decisions**:
- `currentVideoId` is a string, not a URL, so callers must extract an id (the existing heuristic stores URL only; Phase 2 derives the id by matching URL → highlight item id at lookup time).
- `agreed` is only valid when `currentVideoId !== null`. Enforced both in the prompt (instruction to the model) and at the boundary (if the agent returns `agreed` for a null-current case, coerce to `no_match`).

### `rematchVideo` function

**Pattern to follow**: `src/cli/weekly-review/agent.ts` — same Anthropic SDK shape, same timeout/retry pattern, same cost estimate using exported `estimateCost`. Re-use `AgentClient`, `defaultClient`, `AgentTimeoutError`, `AgentResponseError`.

**Overview**: One Anthropic tool-use round per call (tool capped at 3 iterations as a safety net), single mandatory `pick_video` tool.

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import {
  AgentClient,
  AgentResponseError,
  AgentTimeoutError,
  defaultClient,
  estimateCost,
  type ContentBlock,
} from "../cli/weekly-review/agent";
import type { Logger } from "../logger";

const ATTEMPT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1024;
const MAX_ROUND_TRIPS = 3;

const PICK_VIDEO_TOOL: Tool = {
  name: "pick_video",
  description:
    "Pick the highlight video whose description best matches the play. " +
    "Return null for video_id if no candidate is a clear match.",
  input_schema: {
    type: "object",
    properties: {
      video_id: {
        type: ["string", "null"],
        description:
          "id of the chosen video from the candidate list, or null when no candidate matches.",
      },
      reason: { type: "string" },
    },
    required: ["video_id", "reason"],
  },
};

export async function rematchVideo(
  apiKey: string,
  model: string,
  input: RematchInput,
  logger: Logger,
  clientOverride?: AgentClient,
): Promise<RematchResult> {
  // 1. Build system + user prompt (see below).
  // 2. Loop up to MAX_ROUND_TRIPS waiting for a `pick_video` tool_use block.
  // 3. Validate the returned video_id is in input.candidates (or null).
  // 4. Map to RematchResult per FR-1.4 / FR-1.11.
}
```

**Key decisions**:
- Tool is `["string", "null"]` (JSON Schema union) so the model can express no_match directly via the tool, instead of refusing to call it.
- Reason is `required` so we always have audit text for the log.
- `MAX_OUTPUT_TOKENS = 1024` (re-match doesn't need 4096).
- Temperature 0, same as weekly-review.
- Validation rules at the boundary:
  - `video_id === null` → `no_match`
  - `video_id` not in `candidates` → `no_match` (log a warn)
  - `video_id === currentVideoId` → `agreed` if `currentVideoId !== null`, otherwise `no_match`
  - Else → `swapped`

**Implementation steps**:
1. Build `system` prompt: short instructions on the task; rules about returning null when uncertain; rule that `currentVideoId` (when present) is allowed but discouraged unless clearly right.
2. Build `user` content: play description + candidate list as a numbered list of `[id] description`.
3. Run tool-use loop:
   - Call `client.create({ model, tools: [PICK_VIDEO_TOOL], ... })` with `ATTEMPT_TIMEOUT_MS` race.
   - On transient failure (timeout, 5xx, rate limit), retry once after `RETRY_DELAY_MS`.
   - Find the first `tool_use` block named `pick_video`.
   - If absent, append a nudge message and re-call (up to MAX_ROUND_TRIPS), then return `no_match`.
4. Validate input and produce `RematchResult`. Log one structured line: `{ gamePk, priorVideoId, decision, newVideoId, costUsd, roundTrips }`.
5. If the SDK throws non-transient errors, propagate (caller logs).

### Prompt structure

```text
SYSTEM:
You are an expert at matching MLB play descriptions to highlight video descriptions.

You will receive:
- A play description.
- The id of the video currently attached to this play (may be null if none has been matched yet).
- A numbered list of candidate videos for the same game, each with an id and a description.

Call the `pick_video` tool exactly once.
- Return the id of the candidate that best matches the play.
- If the currently attached video is already the best match, return its id (only valid when a current id was provided).
- If no candidate is a clear match, return null.
- Always include a brief reason.

USER:
Play description:
{playDescription}

Currently attached video id: {currentVideoId | "none"}

Candidates:
[v123abc] Betts throws out Acuna at third in the 7th
[v456def] Acuna's RBI single off the wall in the 7th
...
```

## Data Model

No schema changes in Phase 1.

## API Design

None — this is a library function. Phase 2 adds the Slack-side surface.

## Testing Requirements

### Unit Tests

| Test File | Coverage |
|-----------|----------|
| `src/detection/__tests__/rematch-agent.test.ts` | All decision branches, validation, retry path, max-round-trip exhaustion |

**Key test cases**:
- **swap happy path**: mock client returns `pick_video` with a `video_id` that exists in candidates and differs from `currentVideoId` → result is `{ decision: 'swapped', videoId: <new>, reason }`.
- **agreed**: mock returns `pick_video` with `video_id === currentVideoId` (non-null) → result is `{ decision: 'agreed', reason }`.
- **no_match via null**: mock returns `pick_video` with `video_id: null` → result is `{ decision: 'no_match', reason }`.
- **no_match via unknown id**: mock returns `video_id` not present in `candidates` → result is `no_match`, warn logged.
- **agreed coerced to no_match when currentVideoId is null**: mock returns `pick_video` with non-null `video_id` equal to a non-existent current → result is `swapped` if id is in candidates, else `no_match`.
- **null current, agent picks a candidate**: result is `swapped` with the new id (no `agreed` path because there was nothing to agree with).
- **agent never calls tool**: mock returns text-only response on every iteration → loop hits `MAX_ROUND_TRIPS`, result is `no_match`.
- **transient error retried once**: first `create` call throws `AgentTimeoutError`, second succeeds → result is the second call's outcome.
- **non-transient error propagates**: first call throws an auth error → function rejects with that error.

### Integration Tests

None for Phase 1. The function is unit-testable in isolation and Phase 2's tests will cover the wiring.

### Manual Testing

- [ ] One-off smoke against a real game: pick an OF-assist play whose first-pass video was wrong, fetch the game's video list, call `rematchVideo` with a real Anthropic key, verify the result is sensible and runs in <15s. Record outcome in the PR.

## Error Handling

| Error Scenario | Handling Strategy |
|----------------|-------------------|
| Anthropic timeout (>30s per round) | Retry once after 5s; on second timeout, throw `AgentTimeoutError` upward — Phase 2 catches and posts a "re-match failed" thread reply. |
| Anthropic 5xx / rate limit | Retry once; same upward propagation if it persists. |
| Anthropic 4xx (bad key, bad request) | Propagate immediately. Not a re-match failure mode the user can fix via reaction; needs operator action. |
| `pick_video` never called within MAX_ROUND_TRIPS | Return `no_match` with `reason: "agent did not call pick_video"`. |
| `video_id` not in candidates | Return `no_match`, log warn with the bogus id. |
| Malformed `input` from tool call (missing required fields) | Return `no_match`, log warn. |

## Validation Commands

```bash
bun run typecheck
bun test src/detection/__tests__/rematch-agent.test.ts
bun test  # full suite — confirm no regression from re-exporting defaultClient
```

## Rollout Considerations

- **Feature flag**: not required at this layer; Phase 2 gates the user-visible path.
- **Monitoring**: structured log line per invocation makes grep-based debugging cheap.
- **Rollback**: pure new module. Deleting `rematch-agent.ts` and reverting the agent.ts export reverts the phase.

## Open Items

- [ ] Confirm `defaultClient` exporting from `agent.ts` doesn't break any current tests that rely on it being private. Skim the test file before adding the export keyword.
- [ ] Decide whether the agent sees `title` as part of each candidate. Default: yes — it's one more useful signal per row at near-zero token cost.

---

*This spec is ready for implementation. Follow the patterns and validate at each step.*
