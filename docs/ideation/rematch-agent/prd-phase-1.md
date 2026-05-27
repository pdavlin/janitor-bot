# PRD: rematch-agent - Phase 1

**Contract**: ./contract.md
**Phase**: 1 of 2
**Focus**: Re-match agent module — pure unit that takes a play + candidate videos and returns a decision.

## Phase Overview

Phase 1 builds a single, testable function — the re-match agent — and nothing else. Its job: given a finding's play description, the full list of video descriptions for the game, and the currently displayed video id (if any), return one of three decisions: `swapped` with a new video id, `agreed` (same as current), or `no_match` (agent declined to pick).

Sequencing this first isolates the riskiest pieces of the project: the prompt, the Anthropic tool-use schema, and how the agent expresses "I think the first pass was right." If any of those are wrong, every downstream pixel of Slack UX is wasted work. Locking the agent's contract first means Phase 2 can mock this module deterministically.

Value after this phase: a unit-tested function that can be invoked from anywhere (CLI, scratch script) to re-match a play. No user-facing change yet.

## User Stories

1. As the engineer building Phase 2, I want a single function `rematchVideo(input)` with a typed result, so I can wire Slack without re-deriving prompts or tool schemas.
2. As an engineer debugging a wrong swap, I want the agent's decision to be loggable end-to-end (prior video, new video, reasoning excerpt) so I can audit it later.
3. As an engineer worried about cost, I want a single Anthropic call per re-match invocation (one tool-use loop, capped iterations) so behavior is predictable.

## Functional Requirements

### Agent Interface

- **FR-1.1**: Export a function `rematchVideo(input: RematchInput): Promise<RematchResult>` from `src/detection/rematch-agent.ts`.
- **FR-1.2**: `RematchInput` carries: `playDescription` (string), `currentVideoId` (string | null), `candidates` (array of `{ id, description, ... }` matching the existing video-candidate shape used by the heuristic), and `gamePk` (for logging/context).
- **FR-1.3**: `RematchResult` is a discriminated union: `{ decision: 'swapped', videoId: string, reason?: string } | { decision: 'agreed', reason?: string } | { decision: 'no_match', reason?: string }`.
- **FR-1.4**: When `currentVideoId` is `null` (first pass found nothing), `agreed` is not a valid decision; the agent must return `swapped` or `no_match`.
- **FR-1.5**: The agent never returns a `videoId` that is not in the `candidates` list.

### Anthropic Tool-Use

- **FR-1.6**: Reuse the SDK and tool-use loop pattern from `src/agents/weekly-review` (commit 40ad013). Same client, same model (Sonnet 4.6).
- **FR-1.7**: Define a single tool `pick_video` with parameters `{ video_id: string | null, reason: string }`. `null` signals no_match.
- **FR-1.8**: The system prompt instructs the model to read the play description, scan candidate video descriptions, and call `pick_video` exactly once.
- **FR-1.9**: The tool-use loop is capped at 3 iterations. If the model has not called `pick_video` by then, the function returns `no_match`.
- **FR-1.10**: If `pick_video` returns a `video_id` that is not in `candidates`, treat as `no_match` and log.
- **FR-1.11**: If `pick_video` returns `currentVideoId`, the function maps that to `decision: 'agreed'`.

### Configuration

- **FR-1.12**: Reuse the existing Anthropic API key env var (whatever the weekly-review agent uses). No new secrets.
- **FR-1.13**: Expose model choice via the same project config surface as the weekly-review agent (do not hard-code in the new module if the existing one is configurable).

## Non-Functional Requirements

- **NFR-1.1**: A single re-match call completes in under 15 seconds at p95 (Sonnet 4.6 with a typical game's worth of candidates — usually 20-80 videos).
- **NFR-1.2**: No network calls outside Anthropic. The candidate list is passed in; this module does not fetch from MLB or Savant.
- **NFR-1.3**: Module has zero Slack dependencies. No imports from `src/notifications/**`.
- **NFR-1.4**: Logging uses the project's existing logger; one structured log line per invocation with `{ gamePk, finding ref if provided, prior video id, decision, new video id, iterations used }`.

## Dependencies

### Prerequisites

- Anthropic tool-use scaffolding from commit 40ad013 already merged on `main` (it is).
- Existing video-candidate shape from the OF-assist heuristic — agent input reuses that type, no new type to invent.

### Outputs for Next Phase

- `rematchVideo` function with stable signature and `RematchResult` discriminated union.
- Test fixtures for candidate lists (real-ish video description shapes) that Phase 2 can reuse for integration tests.

## Acceptance Criteria

- [ ] `bun test src/detection/__tests__/rematch-agent.test.ts` passes with cases for: swap to a different valid candidate, agreement with current video, no_match when nothing is appropriate, no_match when the tool returns an out-of-list id, no_match when the tool is never called within the iteration cap, and the `currentVideoId === null` branch.
- [ ] The Anthropic client is mocked in tests; no real API calls.
- [ ] The function returns inside 15s in a live smoke test against one real game's video list (manual, one-off — record the result in the PR).
- [ ] Type-check passes (`bun run typecheck` or project equivalent).
- [ ] No imports from `src/notifications/**` or `src/daemon/**` in this module.

## Open Questions

- Does the existing weekly-review agent expose a reusable client/helper for tool-use loops, or do we duplicate the loop in `rematch-agent.ts`? (Resolve during spec by reading commit 40ad013.)
- Should the agent see the heuristic's score for each candidate as a hint, or only descriptions? Default to descriptions-only to avoid anchoring the agent on the same signal that already failed.

---

*Review this PRD and provide feedback before spec generation.*
