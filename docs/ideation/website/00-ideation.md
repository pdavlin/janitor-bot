# janitor-bot.exe.xyz — website ideation

Date: 2026-07-08
Status: Gate 1 (batch approval)

## Goal

Grow the single landing page into a small split site:

- Public front: what the bot is, best recent highlights, season stats.
- Denser stats/ops section: engagement, weekly-review agent health, pipeline internals.

Design stays in the davlin.io family (base16 warm greys, monospace, fieldset cards)
but with its own fixed accent identity instead of the daily rotation.

## Decisions made (overseer)

1. **Architecture: server-rendered, zero-build.** Pages render as HTML strings on the
   daemon (same as today's landing page), refactored from one giant literal into
   template modules under `src/server/pages/`. Charts are inline SVG generated
   server-side. Rationale: data is tiny (~400 plays), the daemon already serves the
   site, and adding a React/bundler layer to a long-lived systemd daemon buys nothing
   at this scale. Revisit only if a module genuinely needs client interactivity.
2. **Accent identity: `--base_08` (#ca4949, red).** Baseball-stitching red,
   distinct from davlin.io's default teal. Fixed, not daily-rotating — the rotation
   is davlin.io's signature; janitor-bot gets its own.
3. **Shared style layer.** Extract the inline CSS into one `theme.ts` module with the
   full davlin.io token set (space scale, breakout grid, flow/cluster utilities,
   date-badge, blockquote) so every page shares it.
4. **Ops data stays server-rendered from SQLite directly.** No new public JSON
   endpoints for votes/findings unless a module needs client fetch. Keeps the API
   surface small.

## Candidate modules

Scored value (V) and effort (E), 1–5.

### Public front

| # | Module | What it shows | Data | V | E |
|---|--------|---------------|------|---|---|
| 1 | Highlight gallery | Recent high-tier plays: team emoji matchup, fielder, target base, inning/score context, credit chain, video link. Filter by tier/team. | `plays` | 5 | 3 |
| 2 | Season stat charts | Tier distribution, plays per week over the season, target-base breakdown (2B/3B/Home), direct vs relay chains. Inline SVG. | `plays`, `/stats` | 5 | 3 |
| 3 | Arm leaderboard | Top fielders by assist count with position + tier mix; teams most burned on the bases. | `plays` | 4 | 2 |
| 4 | About/explainer | Illustrated pipeline walkthrough: detect → tier → post → vote → weekly review. Fieldset-per-stage diagram. | static | 4 | 2 |
| 5 | Today feed | Live view of today's detections. Empty most of the day off-season. | `/plays/today` | 2 | 1 |

### Stats/ops section

| # | Module | What it shows | Data | V | E |
|---|--------|---------------|------|---|---|
| 6 | Engagement board | Fire/trash net scores, most-loved and most-disputed plays, tier-review flags. | `vote_snapshots`, `votes` | 4 | 3 |
| 7 | Agent ops | Weekly-review runs: status, cost, tokens, tool calls; findings with severity/outcome; confirm-vs-reject rate over time. | `agent_runs`, `agent_findings` | 4 | 3 |
| 8 | Pipeline health | Video fetch status breakdown, rematch/angle decisions, overturned plays, scheduler status. | `plays`, `play_rematch_events`, `/health` | 3 | 2 |

## Proposed batches

- **Batch 1 (foundation + public front):** shared theme/layout refactor, then
  modules 1, 2, 3, 4. One coherent public site in the first pass.
- **Batch 2 (stats/ops):** modules 6, 7, 8 behind a `/ops` section.
- **Dropped for now:** module 5 (today feed) — low value until it can share the
  gallery's rendering for free.

## Lifecycle per batch

1. **Ideation** — this doc.
2. **Design** — design brief (tokens + layout rules), then static HTML mockups with
   real prod data baked in, published as artifacts for review. Gate 2: mockup approval.
3. **Development** — implement per module against SQLite/API, branch per batch.
4. **Testing** — `bun test` for data-shaping and route tests; render pages against
   prod-copy DB, empty DB, and edge cases (no video, missing fields, long names).
5. **QA** — visual pass (light/dark, 360px viewport), token-conformance check
   against the brief, `/code-review`, then merge + deploy to the VM.
