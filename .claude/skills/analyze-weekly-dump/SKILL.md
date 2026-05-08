---
name: analyze-weekly-dump
description: Pull the latest weekly-review dump file from the janitor-bot prod VM and walk through its findings interactively. Use when the user wants to review a weekly digest, decide which findings to mark confirmed/rejected, evaluate prompt quality, or iterate on the weekly-review prompt. Triggers on phrases like "analyze the weekly review", "review the latest dump", "go through this week's findings", "let's look at this week's run".
---

# Analyze Weekly Dump

Walks the operator through a captured weekly-review run, finding by finding, and produces a list of `--resolve` commands to apply once decisions are made.

## When to use

- The Monday timer fired and the operator wants to triage the digest.
- The operator is iterating on the prompt and wants to inspect a specific captured run.
- A `dump_captured` DM landed and the operator wants to act on it.

## Inputs

- Optional dump filename. When omitted, the skill fetches the most recent dump from prod.
- Optional `--week-starting YYYY-MM-DD` to target a specific past run.

## Workflow

### 1. Fetch the dump

If the user didn't name a specific dump, fetch the latest from prod. Use `ssh` + `scp`:

```bash
LATEST=$(ssh janitor-bot.exe.xyz \
  'ls -1t ~/janitor-bot/weekly-review-dumps/*.json 2>/dev/null | head -1')
if [ -z "$LATEST" ]; then
  echo "No dumps on prod. Either no full run with --dump has fired yet, or the file was already pulled."
  exit 1
fi
mkdir -p ./weekly-review-dumps
scp "janitor-bot.exe.xyz:$LATEST" ./weekly-review-dumps/
echo "Pulled: ./weekly-review-dumps/$(basename "$LATEST")"
```

If the user named a specific dump (full or partial filename), grep the prod listing for it and scp that one.

### 2. Read the dump and present a summary

Use the Read tool on the local copy. Pull out:

- Week window (`window.weekStarting` to `window.weekEnding`)
- Model and cost (`model`, `response.estimatedCostUsd`)
- Token usage (`response.inputTokens`, `response.outputTokens`)
- Accepted finding count (`validated.accepted.length`)
- Rejected finding count + reasons (`validated.rejected[].reason`, grouped)
- Number of game transcripts (`transcript.games.length`)

Present these in a small table or bullet list. Don't dump the raw JSON.

### 3. Walk through findings

Iterate `validated.accepted`. For each finding, present:

- `finding_type`
- `severity`, `evidence_strength`, `trend`
- `description` (full text — already validated, so safe to surface verbatim)
- `suspected_rule_area`
- `evidence_play_ids` — for each play id, find the corresponding entry in the prompt's `## Plays` section (parse the dump's `prompt.user`) so the operator sees `position / targetBase / tier / runnersOn / teams`. If parsing the prompt is awkward, just show the play ids.
- For each play with thread discussion, optionally surface the relevant `transcript.games[*].messages[]` (filter by `gamePk` matching the play's game).

Then use `AskUserQuestion` with options:

- **Confirmed** — operator agrees, would consider tuning
- **Rejected** — operator disagrees (false positive)
- **Skip / defer** — leave as `pending` for now
- **Discuss** — pause and dig into the finding before deciding

Capture the operator's choice. If "Discuss", drop into a free-form conversation about that finding before moving on.

### 4. Surface rejected findings

After the accepted findings, briefly note the rejected ones. Validation reasons are already abstract (e.g. `quote: 3, mention: 1`), so no privacy concern. The operator may want to flag patterns ("the model keeps hitting the quote rule on this kind of finding") for prompt iteration.

### 5. Produce resolve commands (full-run dumps only)

Check `dump.runId`. The behavior branches:

**Full-run dump (`runId !== null`)**: findings are persisted in `agent_findings` on prod. For each finding the operator marked `confirmed` or `rejected`, build:

```
bun run weekly-review --resolve <run_id> <finding_id> <confirmed|rejected>
```

`run_id` is `dump.runId` (same for all findings). `finding_id` comes from prod via:

```bash
ssh janitor-bot.exe.xyz \
  "sqlite3 /home/exedev/janitor-bot/janitor-throws.db \
   'SELECT id, finding_type FROM agent_findings WHERE run_id = $RUN_ID ORDER BY id ASC;'"
```

Match `finding_type` between dump and SQL row. Types are typically unique per run.

Present the resolved list. Offer two ways to apply:

1. **Manual** — paste the commands and run them yourself.
2. **Run via SSH** — execute in a single batched command. Confirm with `AskUserQuestion` before mutating prod.

**Dry-run dump (`runId === null`)**: no persisted findings to resolve. The walkthrough is still useful for prompt iteration (Step 6). Skip resolve-command generation; surface what the operator might note for the next real run.

### 6. Optional: prompt iteration

If the operator wants to test a prompt revision against this dump:

- Ask which prompt they want to swap (system, user, or both).
- Have them write the variant to a local file (or paste into a temp file).
- Run `bun run replay:prompt --dump <local-path> --system <variant>` (or `--user`).
- Compare diff output side-by-side with the original.

## Caveats

- **Finding ids are not in the dump.** The dump captures `validated.accepted` (the raw `Finding` objects from validation), but the autoincrement `id` column gets assigned at `persistFindings` time, AFTER the dump is written. To get ids, query prod:

  ```bash
  ssh janitor-bot.exe.xyz \
    "sqlite3 /home/exedev/janitor-bot/janitor-throws.db \
     'SELECT id, finding_type FROM agent_findings WHERE run_id = $RUN_ID ORDER BY id ASC;'"
  ```

  Match `finding_type` between the dump's `validated.accepted[].finding_type` and the SQL row's `finding_type`. Types are unique per run in practice.

- **Resolved findings don't roll back.** A confirmed/rejected outcome is durable. Be deliberate before bulk-applying.

- **The dump file stays on disk locally after pulling.** The local `./weekly-review-dumps/` is gitignored; treat the files as transcript-bearing artifacts (do not paste contents into chat platforms or other repos).

## Example invocation

User: "let's go through this week's run"

Skill:
1. Fetches latest dump.
2. Summarizes: "Week of 2026-05-03. claude-sonnet-4-6, $0.024. 4 accepted, 1 rejected (quote: 1). 8 games with thread discussion."
3. Walks through findings 1 of 4: "video_availability_gap (watch, moderate). Pattern: ..."
4. Asks: confirmed / rejected / skip / discuss?
5. Repeats for all 4.
6. Produces 4 `--resolve` commands. Offers to apply via ssh.
