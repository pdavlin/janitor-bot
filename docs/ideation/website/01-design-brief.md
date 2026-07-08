# janitor-bot website — design brief

Date: 2026-07-08
Status: governs batch 1 mockups and implementation.

## Identity

Sibling site of davlin.io: same bones (base16 warm greys, monospace, fieldset
cards, 44rem column), own identity via a **fixed red accent** (`--base_08`,
#ca4949 — baseball-stitching red). No daily accent rotation; that flourish stays
davlin.io's.

Font: system monospace stack (BerkeleyMono is licensed to davlin.io; do not copy
the woff). `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas,
'Liberation Mono', monospace`.

## Site map

| Path | Page | Batch |
|------|------|-------|
| `/` | Home: intro, 3 recent high-tier plays, headline stat tiles, nav | 1 |
| `/highlights` | Full gallery with filters | 1 |
| `/season` | Stat charts + arm leaderboard | 1 |
| `/about` | Illustrated pipeline explainer | 1 |
| `/ops` | Engagement, agent runs, pipeline health (public, unlinked) | 2 |

Existing JSON routes (`/plays`, `/plays/today`, `/plays/:id`, `/stats`,
`/health`) stay untouched.

## Token layer (copy verbatim)

```css
:root {
  --base_00:#1b1818; --base_01:#292424; --base_02:#585050; --base_03:#655d5d;
  --base_04:#7e7777; --base_05:#8a8585; --base_06:#e7dfdf; --base_07:#f4ecec;
  --base_08:#ca4949; --base_09:#b45a3c; --base_0a:#a06e3b; --base_0b:#4b8b8b;
  --base_0c:#5485b6; --base_0d:#7272ca; --base_0e:#8464c4; --base_0f:#bd5187;

  --accent-color: var(--base_08);
  --color-bg: var(--base_07);
  --color-text: var(--base_01);
  --color-bg-accent: color-mix(in oklch, var(--accent-color) 15%, var(--color-bg));
  --color-text-accent: var(--accent-color);
  --color-theme-offset: color-mix(in oklch, var(--accent-color) 80%, var(--color-text));
  --color-theme-muted: color-mix(in oklch, var(--accent-color) 20%, var(--color-bg));
  --color-highlight: color-mix(in oklch, var(--accent-color) 30%, var(--color-bg));
  --color-text-muted: var(--base_03);

  --page-max: 44rem;
  --page-gutters: clamp(var(--space_m), 3vw, var(--space_xl));
  --space_3xs: clamp(.25rem,.24rem+.06vw,.3125rem);
  --space_2xs: clamp(.5rem,.49rem+.06vw,.5625rem);
  --space_xs:  clamp(.75rem,.73rem+.12vw,.875rem);
  --space_s:   clamp(1rem,.98rem+.12vw,1.125rem);
  --space_m:   clamp(1.5rem,1.46rem+.19vw,1.6875rem);
  --space_l:   clamp(2rem,1.95rem+.25vw,2.25rem);
  --space_xl:  clamp(3rem,2.93rem+.37vw,3.375rem);

  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas,
               'Liberation Mono', monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) { --color-bg: var(--base_01); --color-text: var(--base_07);
    --color-text-muted: var(--base_05); }
}
:root[data-theme='dark'] { --color-bg: var(--base_01); --color-text: var(--base_07);
  --color-text-muted: var(--base_05); }
:root[data-theme='light'] { --color-bg: var(--base_07); --color-text: var(--base_01);
  --color-text-muted: var(--base_03); }

body { background: var(--color-bg); color: var(--color-text);
  font-family: var(--font-mono); line-height: 1.5; }
h1,h2,h3 { line-height: 1.1; text-wrap: balance; }
::selection { background: var(--color-highlight); }
a { color: inherit; text-decoration-color: var(--accent-color); }
a:hover { color: var(--color-text-accent); }
:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent-color),
  0 0 0 4px var(--color-bg), 0 0 0 6px var(--color-text); }

main { display: grid;
  grid-template-columns:
    [full-start] minmax(var(--page-gutters), 1fr)
    [content-start] min(100% - 2*var(--page-gutters), var(--page-max)) [content-end]
    minmax(var(--page-gutters), 1fr) [full-end]; }
main > * { grid-column: content; }
.flow > * + * { margin-block-start: var(--flow-space, 1em); }
.cluster { display: flex; flex-wrap: wrap; gap: var(--space_xs); align-items: center; }
.title { font-size: 2.5rem; letter-spacing: 1.25px; text-transform: uppercase;
  margin-bottom: var(--space_m); }

fieldset { border: 1px solid var(--base_03); padding: .75rem 1rem; margin: 1rem 0;
  transition: border-color .15s ease-out; min-inline-size: 0; }
fieldset:hover, fieldset:focus-within { border-color: var(--accent-color); }
legend { padding: 0 .5em; color: var(--color-text-muted); font-weight: bold;
  font-size: .75rem; text-transform: lowercase; transition: color .15s ease-out; }
fieldset:hover legend, fieldset:focus-within legend { color: var(--accent-color); }
```

Page shell: `<header>` with a `fieldset legend="header"` nav (right-aligned
cluster: home / highlights / season / about), `<main class="flow">`, sticky
footer fieldset `legend="footer"` with "built with bun · running on exe.dev" and
a davlin.io link. Lowercase legends everywhere.

## Components

**Play card** (gallery + home): a fieldset, `legend` = date (e.g. `2026-06-21`).
Contents:
- Matchup line: `AWY @ HOM` team badges + final-at-time score `3–2`, inning
  `top 7`, outs, runners on.
- Headline: fielder name + position, arrow to target base, runner name.
  e.g. `Ronald Acuña Jr. (RF) ⟶ Home · cut down Ozzie Albies`.
- Credit chain rendered as monospace path: `RF -> SS -> C` (relay) or `RF -> C`
  (direct). Overturned plays get an `overturned` tag.
- Tier badge: colored dot + lowercase word (`● high`). Never color alone.
- Video link if present: `▶ watch` (accent underline). Missing video: muted
  `no video` text, no dead link.
- Team badges in mockups: text abbreviation in a 1px-border box. Production
  swaps in `mlb_teams_emoji/<team>.png` at 20px.

**Stat tile** (home headline numbers): fieldset with lowercase legend
(`plays tracked`), hero number ~2.5rem, one-line context in muted text.
Three tiles in a responsive cluster.

**Tier colors** (ordinal → single-hue sequential from accent):
- high: `var(--base_08)` #ca4949
- medium: `color-mix(in oklch, var(--base_08) 55%, var(--color-bg))`
- low: `color-mix(in oklch, var(--base_08) 25%, var(--color-bg))`
Always paired with the text label.

## Charts (/season)

Server-rendered inline SVG, no chart library. Theme via CSS variables inside the
SVG (`fill="var(--accent-color)"`, text in `var(--color-text-muted)`).

**Validated categorical palette** (six checks pass, light `#f4ecec` and dark
`#292424`; fixed assignment order, never cycled):

| Slot | Hex | Assigned to |
|------|-----|-------------|
| 1 | `#ca4949` | primary series; target base **Home**; **direct** throws |
| 2 | `#00a3a3` | target base **2B**; **relay** throws |
| 3 | `#4f83d1` | target base **3B** |
| 4 | `#c0761c` | reserve |

Note: `#00a3a3` has a light-mode contrast WARN (2.67:1) — relief is mandatory:
every chart using it carries direct labels and a table view.

Chart inventory:
1. **Plays per week** — bar, single series (accent red). No legend (title names
   it). Crosshair/hover tooltip per bar.
2. **Tier distribution** — horizontal bars, tier sequential colors, direct
   count labels.
3. **Target base breakdown** — horizontal bars, categorical slots 1–3, direct
   labels + legend.
4. **Direct vs relay** — grouped or 100%-stacked bar per target base, slots 1–2,
   2px surface gaps between segments.

Rules (from dataviz skill, binding):
- One axis. Never dual-axis.
- Thin marks, 4px rounded data-ends anchored to baseline, 2px surface gap
  between adjacent fills.
- Selective direct labels, not a number on every point.
- Text wears text tokens, never series color.
- ≥2 series → legend present; single series → no legend.
- Hover tooltips on all plotted charts (small inline vanilla JS).
- Every chart ships a `<details>`-collapsed data table underneath.
- Grid/axes recessive: 1px `color-mix(in oklch, var(--color-text) 12%, transparent)`.

**Arm leaderboard**: table-like fieldset, top 10 fielders — rank, name,
position, assist count as a thin inline bar (accent), tier mix as three small
colored dot-counts. Teams-most-burned as a second smaller list.

## /about explainer

Pipeline as five fieldset stages connected by vertical `|` / `v` ASCII
connectors, each legend a stage name (detect, tier, post, vote, review). Inside
each: 2–3 sentences plain language + one real artifact (a sample credit chain,
a tier score rationale, a fire/trash tally, a sample finding). Terminal-diagram
aesthetic; no images.

Tier copy must match `src/detection/ranking.ts` exactly: Home > 3B > 2B, direct
+2, 3+-segment relay −2, video +1, overturn −2, and +1 for 95+ mph throws when
Statcast velocity is available.

## QA checklist (used at gate 5)

- Light + dark render correctly (data-theme override and media query).
- 360px viewport: no horizontal body scroll; wide content scrolls inside its
  own container.
- All colors trace to tokens or the validated chart palette. No new hexes.
- Tier/status never encoded by color alone.
- Charts match the dataviz anti-pattern catalog (none present).
