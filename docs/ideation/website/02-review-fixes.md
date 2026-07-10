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

## Deferred review debt (confirmed, not fixed — batch-2 candidates)

- **Direct-throw rule triple-encoded**: `ranking.ts` (split length), `components.ts`
  playCard (same split), `db.ts` queryDirectRelayByBase (SQL length arithmetic,
  magic 4 = separator length). One exported chain helper, or a persisted
  segment-count column.
- **Filter parser twin**: `parseHighlightsFilters` duplicates `parsePlayFilters`
  field-by-field, differing only in lenient-vs-400 policy. One parser
  parameterized on strictness.
- **Route table**: `KNOWN_ROUTES` hand-mirrors the dispatch if-chain for
  405-vs-404; a single `[{match, handler}]` table drives both.
- **Team map duplication**: `team-assets.ts` TEAM_ASSET_FILES vs
  `notifications/team-emoji.ts` TEAM_ABBREV_TO_EMOJI; drift test covers only the
  latter.
- **queryTierCounts** duplicates queryPlayStats' tier aggregate.
- **highlights.ts** enumerates the four filter keys in three places (form,
  queryString, emptyState).
- **Form option constants** duplicate routes.ts VALID_* sets; `?base=1B` is
  unreachable from the gallery while /season displays 1B rows.
- **theme.ts** carries page-specific CSS despite the shared-only contract; shell
  needs a per-page CSS slot.
- **season.ts** six section renderers copy-paste fieldset + empty-state wrappers.
- **Perf (all low-severity at current traffic)**: /season runs 9 uncached
  aggregates per hit; leaderboard correlated subquery re-aggregates per fielder;
  team assets stat+read per request; queryDistinctTeams UNION scan per gallery
  view; /about page rebuilt per request. Slack acks before dispatch, so none of
  this threatens the 3s deadline today.
- **Plausible-only**: single-node credit chains would be labeled "relay"
  (requires anomalous feed data).
