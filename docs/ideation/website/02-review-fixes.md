# Website batch-1 code-review fixes

Applied to the server-rendered site (`src/server/**`, `src/storage/db.ts`,
`src/detection/ranking.ts`) on branch `website-batch-1`. Each item below is a
verified review finding with the file it touched and the test that guards it.

## Correctness

1. **Play-card context escaping** (`src/server/pages/components.ts`)
   `playCard` interpolated `play.runnersOn` (a raw DB string) unescaped. Now
   wrapped in `escapeHtml`. Guarded by `components.test.ts`.
2. **Watch-link scheme guard** (`components.ts`)
   The video link now renders only when `videoUrl` parses as `http:`/`https:`
   (new `isSafeHttpUrl` helper); otherwise the muted "no video" state. Blocks
   `javascript:`/`data:` hrefs from a bad row.
3. **`formatShortDate` fallback** (`components.ts`)
   Callers (`home.ts` season span, `season.ts` subhead) treat this output as
   pre-escaped HTML. The non-ISO fallback now returns `escapeHtml(input)`; the
   ISO path is byte-identical to before.
4. **Arm leaderboard grouping** (`src/storage/db.ts`)
   `queryArmLeaderboard` now `GROUP BY fielder_id` (display name via
   `MAX(fielder_name)`, position subquery keyed on `fielder_id`). Two players
   sharing a name no longer merge; one player's rows no longer split. Guarded
   by new `queryArmLeaderboard` tests in `db.test.ts`. The `pages.test.ts`
   fixtures were given distinct `fielderId`s (they previously shared one id
   while using four names — impossible data that only "worked" under
   name-grouping).
5. **HTML error path** (`src/server/routes.ts`, new `src/server/pages/error.ts`)
   HTML routes (`/ /highlights /season /about`) return a themed 500 page
   (`renderErrorPage`, built once, DB-free) on an unhandled error instead of a
   JSON blob. JSON routes keep the JSON error. `shell.ts` `active` widened to
   `NavPage | null` so the error page marks no nav item.
6. **Team filter validation** (`routes.ts`)
   `?team=` is uppercased and must match `/^[A-Z]{2,3}$/`; the handler then
   drops it if it is not in `queryDistinctTeams`. Unknown/malformed → unset.
7. **Empty-state copy** (`src/server/pages/highlights.ts`)
   Zero rows with `offset > 0` now says "nothing this far back." (newer link
   kept). "no plays tracked yet." is reserved for offset 0 with no filters.
8. **Page-aligned offset clamp** (`highlights.ts`, `routes.ts`)
   New `HIGHLIGHTS_MAX_OFFSET` = largest multiple of the page size ≤ 10000
   (9996). The offset parser clamps to it and the pager's older-link condition
   derives from it, so the older link vanishes at the boundary instead of
   looping. No magic 9996 literal.
9. **Team-asset CORS** (`src/server/team-assets.ts`)
   `serveTeamAsset` now receives `CORS_HEADERS` and applies them on the 200 and
   both 404s (passed in from `routes.ts` to avoid a circular import).
10. **Season caption** (`src/server/pages/season.ts`)
    The base-color caption no longer claims the colors key every chart; it
    scopes the key to that chart and notes the mix chart has its own legend.

## Small adjacent

11. **Mix chart zero segments** (`src/server/pages/charts.ts`)
    `renderMixChart` skips a zero-count segment entirely (no path, no
    tabindex/aria/tooltip). The lone non-zero segment spans full width, rounded
    end, no gap. Guarded by `charts.test.ts`.
12. **API discoverability** (`src/server/pages/about.ts`, `theme.ts`)
    An "api" fieldset lists `GET /plays`, `/plays/today`, `/plays/:id`,
    `/stats`, `/health` as links (`.api-list` styling).

## Key cleanup

13. **`escapeHtml` via Bun** (`components.ts`)
    Delegates to `Bun.escapeHTML` (repo policy). Note the single-quote entity is
    now `&#x27;` (was `&#39;`); no test asserted the old form.
14. **About copy ↔ ranking contract** (`src/detection/ranking.ts`,
    `about.ts`, new `about.test.ts`)
    `ranking.ts` now exports its point constants (`SCORE_HOME`,
    `DIRECT_THROW_BONUS`, `LONG_RELAY_PENALTY`, `TIER_HIGH_MIN`, …) with no
    behavior change. The about copy interpolates them, so numbers can't drift.
    `about.test.ts` runs the page's worked example (RF→SS→C relay to Home with
    video) through `calculateTier` and asserts "medium", and asserts the copy's
    numbers against the exported constants.

## Test status

`bun test`: 664 pass, 2 fail. The 2 failures are the pre-existing
weekly-review date-window tests in
`src/cli/weekly-review/tools/__tests__/get-historical-finding-outcomes.test.ts`
(date-dependent, unrelated to this work).

Run with the pinned bun if it is not on PATH:
`/Users/pdavlin/.local/share/mise/installs/bun/1.3.14/bin/bun test`.

## Paid down (2026-07-12)

Structural dedups on branch `chore/website-debt-pass`, one commit each.
All are pure refactors: `/`, `/highlights` (plus filter/offset variants),
`/season`, `/about`, and `/ops` rendered byte-identical against the prod
DB copy before and after every step, and the /season direct-vs-relay
numbers were verified unchanged.

- **Direct-throw rule triple-encoded** → `ranking.ts` now exports
  `chainSegments`/`isDirectThrow`, consumed by `calculateTier`, the play
  card's direct/relay label, and `queryDirectRelayByBase` (which fetches
  base + credit_chain and counts in TS instead of SQL length arithmetic).
- **Filter parser twin** → both parsers walk one `SHARED_FILTER_SPECS`
  field spec in `routes.ts`; only the failure policy differs (strict 400
  vs lenient ignore). Team keeps its policy split on purpose: raw
  pass-through for the JSON API, uppercase + shape check for the gallery.
- **Route table** → `GET_ROUTES` drives dispatch, 405-vs-404, and (via an
  `html` flag) the themed-500 error path; `KNOWN_ROUTES` and the if-chain
  are gone.
- **Team map duplication** → `TEAM_ASSET_FILES` derives from
  `TEAM_ABBREV_TO_EMOJI` plus a web-only alternates map
  (AZ/KCR/SDP/SFG/TBR/WSN); the emoji drift test now covers the web map.
- **queryTierCounts** → zero-fill/order wrapper over the tier aggregate
  shared with `queryPlayStats` (`queryTotalByTier`).
- **highlights.ts key triplication** → `FILTER_KEYS` is the single
  enumeration driving the form, queryString, and emptyState.
- **Form option constants** → `src/server/filter-options.ts` exports
  TIER/POSITION/BASE_OPTIONS, consumed by routes.ts VALID_* sets and the
  gallery form. 1B deliberately stays out of the domain (see below).
- **season.ts section wrappers** → local `section()` helper (same pattern
  as ops.ts's) collapses the six fieldset + empty-state copies.

## Deferred review debt (confirmed, not fixed)

- **1B unreachable from gallery** (behavior question, deliberately left):
  `?base=1B` is not an accepted filter while /season displays legacy 1B
  rows. Kept as-is — detection no longer emits 1B-target plays, so this
  is a product call, not a refactor.
- **theme.ts** carries page-specific CSS despite the shared-only contract; shell
  needs a per-page CSS slot. Skipped: touches every page's markup contract,
  out of scope for a byte-identical pass.
- **Perf (all low-severity at current traffic)**: /season runs 9 uncached
  aggregates per hit; leaderboard correlated subquery re-aggregates per fielder;
  team assets stat+read per request; queryDistinctTeams UNION scan per gallery
  view; /about page rebuilt per request. Slack acks before dispatch, so none of
  this threatens the 3s deadline today. Skipped: caching is not a pure refactor.
  Note the direct-vs-relay aggregate now scans base + credit_chain rows in TS
  instead of aggregating in SQL — same order of work at current row counts.
- **Plausible-only**: single-node credit chains would be labeled "relay"
  (requires anomalous feed data). Skipped: behavior change territory.
- **Video-match first-match risk**: `matchVideoToPlay`
  (`src/detection/video-match.ts`) picks the first content-API highlight
  matching fielderId + defense keyword via `items.find`; a game with two
  defense highlights tagged with the same fielder could match the wrong clip.
  Not observed in prod (investigated 2026-07-12, play 823690/25 confirmed
  correct); tighten by preferring the highlight whose description overlaps
  the play description if this ever bites.
