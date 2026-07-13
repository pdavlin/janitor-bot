/**
 * Shared CSS for every server-rendered page.
 *
 * Single source of truth per the batch-1 design brief
 * (docs/ideation/website/01-design-brief.md): minimal reset, the brief's
 * token layer, and all shared element/component styles. Page modules must
 * not redefine anything declared here.
 *
 * Theming is media-query only (prefers-color-scheme); production has no
 * data-theme toggle.
 *
 * Deviation from the brief's token listing: the space-scale clamp() sums
 * carry whitespace around the + operator. CSS math requires it — the
 * brief's compacted form ("1.46rem" glued to "+.19vw") is invalid, and
 * because custom properties fail at computed-value time, it silently
 * dropped every rule consuming the tokens, including the main breakout
 * grid. Guarded by src/server/pages/__tests__/theme.test.ts.
 */

export const THEME_CSS = `
/* ---- minimal reset ---- */
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; }

/* ---- token layer (design brief; spaced calc operators, see module doc) ---- */
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
  --space_3xs: clamp(.25rem, .24rem + .06vw, .3125rem);
  --space_2xs: clamp(.5rem, .49rem + .06vw, .5625rem);
  --space_xs:  clamp(.75rem, .73rem + .12vw, .875rem);
  --space_s:   clamp(1rem, .98rem + .12vw, 1.125rem);
  --space_m:   clamp(1.5rem, 1.46rem + .19vw, 1.6875rem);
  --space_l:   clamp(2rem, 1.95rem + .25vw, 2.25rem);
  --space_xl:  clamp(3rem, 2.93rem + .37vw, 3.375rem);

  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas,
               'Liberation Mono', monospace;

  /* validated categorical chart palette — fixed hexes, theme-independent */
  --chart-1:#ca4949; /* primary · Home · direct */
  --chart-2:#00a3a3; /* 2B · relay */
  --chart-3:#4f83d1; /* 3B */
  --chart-4:#c0761c; /* reserve · 1B */

  /* tier ordinal ramp (single-hue sequential from accent) */
  --tier-high: var(--base_08);
  --tier-medium: color-mix(in oklch, var(--base_08) 55%, var(--color-bg));
  --tier-low: color-mix(in oklch, var(--base_08) 25%, var(--color-bg));

  --grid: color-mix(in oklch, var(--color-text) 12%, transparent);
}
@media (prefers-color-scheme: dark) {
  :root { --color-bg: var(--base_01); --color-text: var(--base_07);
    --color-text-muted: var(--base_05); }
}

body { background: var(--color-bg); color: var(--color-text);
  font-family: var(--font-mono); line-height: 1.5; }
h1,h2,h3 { line-height: 1.1; text-wrap: balance; }
::selection { background: var(--color-highlight); }
a { color: inherit; text-decoration-color: var(--accent-color); }
a:hover { color: var(--color-text-accent); }
:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent-color),
  0 0 0 4px var(--color-bg), 0 0 0 6px var(--color-text); }

main { display: grid; align-content: start;
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

/* ---- page shell ---- */
body { min-height: 100vh; display: flex; flex-direction: column; }
main { flex: 1 0 auto; padding-block: var(--space_m) var(--space_xl); }
.site-header, .site-footer { padding-inline: var(--page-gutters); }
.site-header .nav-field { max-width: var(--page-max); margin-inline: auto;
  margin-block: var(--space_s) 0; }
.site-header .nav-field .cluster { justify-content: flex-end; }
.nav-link { text-decoration: none; padding: .15em .1em; }
.nav-link[aria-current] { color: var(--color-text-accent);
  text-decoration: underline; text-decoration-color: var(--accent-color);
  text-underline-offset: 3px; }
.site-footer { flex-shrink: 0; }
.site-footer .foot-field-wrap { max-width: var(--page-max); margin-inline: auto;
  margin-block: 0 var(--space_s); }
.site-footer .foot-field {
  display: flex; flex-wrap: wrap; gap: .35em var(--space_s);
  justify-content: space-between; align-items: baseline;
  color: var(--color-text-muted); font-size: .8125rem; }

/* ---- home page ---- */
.tagline { color: var(--color-text-muted); max-width: 54ch; margin: 0;
  font-size: 1.0625rem; }
.prose { margin: 0; max-width: 62ch; }
.prose > * + * { margin-top: var(--space_2xs); }
.tiles { align-items: stretch; }
.tiles fieldset { flex: 1 1 12rem; margin: 0; display: flex; flex-direction: column; }
.stat-num { font-size: 2.5rem; line-height: 1; font-weight: 700;
  font-variant-numeric: tabular-nums; letter-spacing: -.5px; }
.stat-num.stat-span { font-size: 1.5rem; padding-block: .35em .15em; }
.stat-ctx { color: var(--color-text-muted); font-size: .8125rem; margin-top: var(--space_3xs); }
.section-head { font-size: .75rem; text-transform: lowercase; font-weight: 700;
  letter-spacing: .5px; color: var(--color-text-muted); margin: 0; }
.cards { margin: 0; }
.cards fieldset { margin: 0; }
.cards > fieldset + fieldset { margin-top: var(--space_s); }
.more { display: inline-block; color: var(--color-text-muted); font-size: .8125rem;
  margin-top: var(--space_xs); }

/* ---- play card ---- */
.gallery { display: grid; gap: var(--space_s);
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); }
.gallery .card { margin: 0; }
.card { display: flex; flex-direction: column; gap: .55rem; }
.card legend { font-variant-numeric: tabular-nums; letter-spacing: .5px; }
.matchup { display: flex; flex-wrap: wrap; align-items: center; gap: .4em .55em;
  font-size: .8125rem; }
.badge { display: inline-block; border: 1px solid var(--base_03); border-radius: 2px;
  padding: .05em .4em; font-size: .6875rem; font-weight: bold; letter-spacing: .5px; }
.team-img { width: 20px; height: 20px; display: inline-block; vertical-align: -5px; }
.at { color: var(--color-text-muted); }
.score { font-variant-numeric: tabular-nums; font-weight: bold; }
.ctx { color: var(--color-text-muted); font-size: .75rem; }
.headline { margin: 0; font-size: .9375rem; line-height: 1.35; }
.headline .pos { color: var(--color-text-muted); }
.headline .arrow { color: var(--color-text-accent); padding: 0 .1em; }
.headline .cut { color: var(--color-text-muted); }
.headline .runner { color: var(--color-text); }
.chain-row { display: flex; align-items: center; gap: .6em; flex-wrap: nowrap;
  min-width: 0; }
.chain-scroll { overflow-x: auto; min-width: 0; padding-bottom: 2px; }
.chain { font-size: .8125rem; letter-spacing: .5px; white-space: nowrap;
  color: var(--color-text); }
.chain .node { color: var(--color-text); }
.chain .sep { color: var(--color-text-muted); padding: 0 .15em; }
.kind { flex-shrink: 0; font-size: .625rem; letter-spacing: .8px;
  text-transform: uppercase; padding: .1em .45em; border-radius: 2px;
  border: 1px solid color-mix(in oklch, var(--color-text) 22%, transparent);
  color: var(--color-text-muted); }
.kind.relay { color: var(--color-text-accent);
  border-color: color-mix(in oklch, var(--accent-color) 45%, transparent); }
.card-foot { margin-top: auto; display: flex; align-items: center;
  justify-content: space-between; gap: .75em; flex-wrap: wrap;
  padding-top: .35rem; }
.tags { display: flex; align-items: center; gap: .55em; flex-wrap: wrap; }
.tier { display: inline-flex; align-items: center; gap: .4em; font-size: .8125rem; }
.dot { width: .6em; height: .6em; border-radius: 50%; display: inline-block;
  flex-shrink: 0;
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 25%, transparent); }
.tier-high .dot { background: var(--tier-high); }
.tier-medium .dot { background: var(--tier-medium); }
.tier-low .dot { background: var(--tier-low); }
.overturned { font-size: .625rem; letter-spacing: .8px; text-transform: uppercase;
  padding: .1em .45em; border-radius: 2px; color: var(--base_08);
  border: 1px solid color-mix(in oklch, var(--base_08) 50%, transparent);
  background: color-mix(in oklch, var(--base_08) 12%, var(--color-bg)); }
.watch { font-size: .8125rem; white-space: nowrap; text-underline-offset: 2px; }
.no-video { font-size: .8125rem; color: var(--color-text-muted); white-space: nowrap; }
.empty { color: var(--color-text-muted); }

/* ---- highlights filters + pager ---- */
.filters .cluster { gap: var(--space_s) var(--space_m); }
.filter { display: flex; flex-direction: column; gap: .3em; }
.filter > span { font-size: .6875rem; letter-spacing: .5px; text-transform: uppercase;
  color: var(--color-text-muted); }
select { font-family: var(--font-mono); font-size: .8125rem; color: var(--color-text);
  background: var(--color-bg); border: 1px solid var(--base_03);
  padding: .35em 2em .35em .55em; border-radius: 0; cursor: pointer;
  appearance: none; -webkit-appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--color-text-muted) 50%),
    linear-gradient(135deg, var(--color-text-muted) 50%, transparent 50%);
  background-position: right 1.05em center, right .75em center;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
  transition: border-color .15s ease-out; }
select:hover { border-color: var(--accent-color); }
.filter-apply { font-family: var(--font-mono); font-size: .8125rem;
  color: var(--color-text); background: var(--color-bg);
  border: 1px solid var(--base_03); padding: .35em .8em; border-radius: 0;
  cursor: pointer; align-self: flex-end;
  transition: border-color .15s ease-out, color .15s ease-out; }
.filter-apply:hover { border-color: var(--accent-color);
  color: var(--color-text-accent); }
.pager { margin-top: var(--space_m); display: flex; justify-content: center;
  gap: 1.5rem; color: var(--color-text-muted); font-size: .8125rem;
  letter-spacing: .5px; }

/* ---- charts (/season) ---- */
.subhead { color: var(--color-text-muted); font-size: .85rem; margin: -.3rem 0 0; }
.chart-note { color: var(--color-text-muted); font-size: .75rem; margin: 0 0 .35rem; }
svg.chart { width: 100%; height: auto; display: block; overflow: visible;
  font-family: var(--font-mono); }
svg.chart text { fill: var(--color-text-muted); }
/* CSS wins over presentation attributes, so emphasised labels need
   classed rules: t-ink for row/count labels, t-onfill for the light
   percentage labels sitting on saturated chart fills. */
svg.chart text.t-ink { fill: var(--color-text); }
svg.chart text.t-onfill { fill: var(--base_07); }
.mark { transition: filter .1s ease-out; }
.mark:hover, .mark:focus-visible { filter: brightness(1.12); outline: none; }
.mark:focus-visible { stroke: var(--color-text); stroke-width: 2; }
.legend { display: flex; flex-wrap: wrap; gap: .1rem 1rem; margin-top: .5rem;
  font-size: .72rem; color: var(--color-text-muted); }
.legend span { display: inline-flex; align-items: center; gap: .35rem; }
.swatch { width: 12px; height: 12px; border-radius: 2px; display: inline-block; }
details { margin-top: .6rem; font-size: .8rem; }
details summary { cursor: pointer; color: var(--color-text-muted);
  list-style-position: inside; }
details summary:hover { color: var(--accent-color); }
.table-wrap { overflow-x: auto; margin-top: .5rem; }
table { border-collapse: collapse; width: 100%; font-size: .78rem;
  font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: .25rem .55rem; white-space: nowrap;
  border-bottom: 1px solid var(--grid); }
th:first-child, td:first-child { text-align: left; }
thead th { color: var(--color-text-muted); font-weight: bold; }

/* ---- leaderboard + teams (/season) ---- */
.lb { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;
  gap: .1rem; }
.lb li { display: grid;
  grid-template-columns: 1.4rem minmax(0, 1fr) auto;
  align-items: center; gap: .5rem .6rem; padding: .35rem 0;
  border-bottom: 1px solid var(--grid); }
.lb .rank { color: var(--color-text-muted); font-variant-numeric: tabular-nums;
  text-align: right; }
.lb .who { display: flex; flex-direction: column; min-width: 0; }
.lb .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lb .pos { color: var(--color-text-muted); font-size: .72rem; }
.lb .metric { display: flex; align-items: center; gap: .6rem; }
.bar-track { width: clamp(44px, 12vw, 130px); height: 8px; background: var(--grid);
  border-radius: 0 4px 4px 0; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent-color);
  border-radius: 0 4px 4px 0; }
.count { font-variant-numeric: tabular-nums; min-width: 1.4rem; text-align: right; }
.tiermix { display: flex; gap: .55rem; font-size: .72rem;
  color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.tiermix span { display: inline-flex; align-items: center; gap: .25rem; }
.tiermix .dot, .legend .dot { width: 8px; height: 8px; }
.teams { list-style: none; margin: 0; padding: 0; display: flex;
  flex-direction: column; gap: .1rem; }
.teams li { display: grid; grid-template-columns: 3rem 1fr 2.2rem;
  align-items: center; gap: .6rem; padding: .28rem 0;
  border-bottom: 1px solid var(--grid); }
.teams .abbr { border: 1px solid var(--base_03); padding: .05rem .3rem;
  font-size: .72rem; text-align: center; border-radius: 2px; }
.teams .tbar-track { height: 6px; background: var(--grid); border-radius: 0 3px 3px 0; }
.teams .tbar-fill { height: 100%; background: var(--color-theme-offset);
  border-radius: 0 3px 3px 0; }
.teams .tn { font-variant-numeric: tabular-nums; text-align: right; }

/* ---- shared tooltip (/season) ---- */
#tt { position: fixed; z-index: 20; pointer-events: none; max-width: 15rem;
  background: var(--color-bg); color: var(--color-text);
  border: 1px solid var(--accent-color); padding: .3rem .5rem;
  font-size: .75rem; line-height: 1.35; border-radius: 3px;
  box-shadow: 0 2px 8px rgba(0,0,0,.25); }
#tt[hidden] { display: none; }
#tt .tt-v { font-weight: bold; font-variant-numeric: tabular-nums; }
#tt .tt-l { color: var(--color-text-muted); }

/* ---- about page ---- */
.lede { color: var(--color-text-muted); max-width: 60ch; }
.lede b { color: var(--color-text); font-weight: bold; }
.pipeline { --flow-space: 0; }
.stage legend { font-size: .8125rem; letter-spacing: .5px; }
.stage .step { color: var(--color-text-muted); font-size: .6875rem;
  letter-spacing: 1px; text-transform: uppercase; }
.stage h2 { font-size: 1.125rem; margin: .15rem 0 .5rem; }
.stage p { margin: .5rem 0; max-width: 62ch; }
.stage .tier { font-size: inherit; font-weight: bold; }
.pipeline .chain { font-size: inherit; font-weight: bold; }
.wire { text-align: center; color: var(--color-text-muted); line-height: 1;
  font-size: .95rem; user-select: none; opacity: .8;
  padding-block: .15rem; }
.wire span { display: block; }
.artifact {
  border: 1px dashed color-mix(in oklch, var(--accent-color) 45%, var(--color-text-muted));
  background: var(--color-bg-accent);
  padding: .6rem .75rem; margin-top: .75rem;
  font-size: .8125rem; overflow-x: auto; }
.artifact .tag { display: inline-block; font-size: .625rem; letter-spacing: 1px;
  text-transform: uppercase; color: var(--color-text-accent);
  border: 1px solid currentColor; padding: 0 .35em; border-radius: 2px;
  margin-bottom: .4rem; }
.artifact .quote { color: var(--color-text); }
.artifact .note { color: var(--color-text-muted); margin-top: .45rem;
  padding-top: .4rem; font-size: .75rem;
  border-top: 1px solid var(--grid); }
.calc { margin-top: .5rem; font-size: .75rem; color: var(--color-text-muted);
  display: grid; grid-template-columns: 1fr auto; gap: .1rem .75rem;
  max-width: 26rem; font-variant-numeric: tabular-nums; }
.calc .op { text-align: right; color: var(--color-text); }
.calc .total { border-top: 1px solid color-mix(in oklch, var(--color-text) 20%, transparent);
  padding-top: .25rem; margin-top: .15rem; color: var(--color-text); font-weight: bold; }
.slack { border: 1px solid var(--base_03); border-left: 3px solid var(--accent-color);
  padding: .6rem .8rem; margin-top: .75rem; font-size: .8125rem;
  background: color-mix(in oklch, var(--color-text) 4%, var(--color-bg));
  overflow-x: auto; }
.slack .bot { color: var(--color-text-accent); font-weight: bold; }
.slack .meta { color: var(--color-text-muted); }
.slack .angles { color: var(--color-text-muted); margin-top: .3rem; }
.slack .angles a { text-decoration-color: var(--accent-color); }
.slack .react { margin-top: .45rem; color: var(--color-text-muted);
  padding-top: .4rem;
  border-top: 1px solid var(--grid); }
.tally { display: flex; gap: 1.25rem; flex-wrap: wrap; margin-top: .3rem;
  font-variant-numeric: tabular-nums; }
.tally b { font-size: 1.05rem; }
.finding-meta { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .45rem; }
.pill { font-size: .625rem; letter-spacing: 1px; text-transform: uppercase;
  border: 1px solid var(--color-text-muted); color: var(--color-text-muted);
  padding: 0 .4em; border-radius: 2px; }
.pill.act { border-color: var(--accent-color); color: var(--color-text-accent); }
.pill.confirmed { border-color: var(--base_0b); color: var(--base_0b); }
.api-list { list-style: none; margin: .6rem 0 0; padding: 0;
  display: grid; gap: .4rem; }
.api-list li { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; }
.api-list a { text-decoration-color: var(--accent-color); }
.api-list .note { color: var(--color-text-muted); font-size: .8125rem;
  margin: 0; padding: 0; border: 0; }

/* ---- ops page ---- */
.ops-note { color: var(--color-text-muted); font-size: .75rem; margin: .1rem 0 0; }
.grp { border-color: color-mix(in oklch, var(--base_03) 70%, transparent); }
.grp > legend { letter-spacing: .5px; }
.grp .flow { --flow-space: var(--space_s); }
.loved { list-style: none; margin: .5rem 0 0; padding: 0; display: flex;
  flex-direction: column; }
.loved li { display: grid; grid-template-columns: 1.4rem minmax(0,1fr) auto;
  gap: .3rem .7rem; align-items: baseline; padding: .45rem 0;
  border-bottom: 1px solid var(--grid); }
.loved li:last-child { border-bottom: 0; }
.loved .rk { color: var(--color-text-muted); font-variant-numeric: tabular-nums;
  text-align: right; font-size: .8125rem; }
.loved .play { min-width: 0; }
/* loved/disputed headlines reuse the play card's .headline span scope,
   one step smaller */
.loved .headline, .disp .top .headline { font-size: .875rem; }
.loved .sub { color: var(--color-text-muted); font-size: .72rem; margin-top: .1rem;
  display: flex; gap: .55rem; flex-wrap: wrap; align-items: center; }
.chain-mini { letter-spacing: .5px; }
.vtally { display: inline-flex; gap: .5rem; font-variant-numeric: tabular-nums;
  font-size: .8125rem; white-space: nowrap; align-items: baseline; }
.vtally .net { font-weight: 700; }
.vtally .up { color: var(--color-text); }
.vtally .dn { color: var(--color-text-muted); }
.disp { list-style: none; margin: .5rem 0 0; padding: 0; }
.disp li { padding: .5rem 0; border-bottom: 1px solid var(--grid);
  display: flex; flex-direction: column; gap: .2rem; }
.disp li:last-child { border-bottom: 0; }
.disp .top { display: flex; flex-wrap: wrap; gap: .4rem .7rem; align-items: baseline;
  font-size: .8125rem; }
.disp .reason { color: var(--color-text-muted); font-size: .72rem; }
.decs { list-style: none; margin: .4rem 0 0; padding: 0; display: flex;
  flex-direction: column; gap: .1rem; }
.decs li { display: grid; grid-template-columns: minmax(5.5rem, auto) 1fr 1.6rem;
  gap: .6rem; align-items: center; padding: .3rem 0;
  border-bottom: 1px solid var(--grid); }
.decs li:last-child { border-bottom: 0; }
.decs .k { display: inline-flex; align-items: center; gap: .4em; font-size: .8125rem; }
.decs .k .dot { width: .55em; height: .55em; }
.decs .dec-track { height: 8px; background: var(--grid); border-radius: 0 4px 4px 0; }
.decs .dec-fill { display: block; height: 100%; border-radius: 0 4px 4px 0; }
.decs .n { font-variant-numeric: tabular-nums; text-align: right; font-size: .8125rem; }
.dec-found .dot, .dec-found .dec-fill { background: var(--base_0b); }
.dec-swap .dot, .dec-swap .dec-fill { background: var(--accent-color); }
.dec-none .dot, .dec-none .dec-fill { background: var(--base_03); }
.legend-inline { display: flex; flex-wrap: wrap; gap: .3rem .9rem; margin-top: .4rem;
  font-size: .7rem; color: var(--color-text-muted); }
.legend-inline span { display: inline-flex; align-items: center; gap: .35rem; }
.legend-inline .dot { width: 8px; height: 8px; }

/* ---- mph chip (play cards, fielder page) ---- */
.mph { flex-shrink: 0; display: inline-flex; align-items: baseline; gap: .25em;
  font-size: .75rem; letter-spacing: .3px; padding: .1em .5em; border-radius: 2px;
  border: 1px solid color-mix(in oklch, var(--base_08) 45%, transparent);
  background: color-mix(in oklch, var(--base_08) 10%, var(--color-bg));
  font-variant-numeric: tabular-nums; }
.mph .n { color: var(--color-text-accent); font-weight: 700; }
.mph .u { color: var(--color-text-muted); font-size: .6875rem; }

/* ---- play-card permalink (the date legend links to /play/:id) ---- */
.card legend .plink { text-decoration: none; }
.card legend .plink:hover { text-decoration: underline;
  text-decoration-color: var(--accent-color); text-underline-offset: 2px; }

/* ---- throw map + velocity charts (/season cannon update) ---- */
svg.throwmap { max-width: 400px; margin: .3rem auto 0; }
.legend.map-legend { justify-content: center; }
.legend.map-legend .swatch { height: 3px; border-radius: 2px; }
.bee { transition: opacity .1s ease-out; }
.bee:hover { opacity: 1; }

/* ---- cannon rankings (/season) ---- */
.cannon { list-style: none; margin: .4rem 0 0; padding: 0; display: flex;
  flex-direction: column; }
.cannon li { display: grid; grid-template-columns: 1.5rem minmax(0, 1fr) auto;
  grid-template-areas: "rank who metric" ". sub sub"; align-items: center;
  gap: .1rem .7rem; padding: .5rem 0; border-bottom: 1px solid var(--grid); }
.cannon li:last-child { border-bottom: 0; }
.cannon .rank { grid-area: rank; color: var(--color-text-muted);
  font-variant-numeric: tabular-nums; text-align: right; font-size: .8125rem; }
.cannon .who { grid-area: who; display: flex; align-items: baseline; gap: .5rem;
  min-width: 0; flex-wrap: wrap; }
.cannon .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cannon .pos { color: var(--color-text-muted); font-size: .72rem; }
.cannon .cannon-metric { grid-area: metric; display: flex; align-items: center;
  gap: .6rem; justify-self: end; }
.cannon-bar-track { width: clamp(48px, 12vw, 120px); height: 6px;
  background: var(--grid); border-radius: 0 3px 3px 0; overflow: hidden; }
.cannon-bar-fill { height: 100%; background: var(--accent-color);
  border-radius: 0 3px 3px 0; }
.cannon-num { font-size: 1.5rem; line-height: 1; font-weight: 700;
  font-variant-numeric: tabular-nums; letter-spacing: -.5px;
  color: var(--color-text); min-width: 4.4rem; text-align: right; }
.cannon-unit { font-size: .7rem; font-weight: 400; color: var(--color-text-muted);
  margin-left: .25rem; letter-spacing: 0; }
.cannon .cannon-sub { grid-area: sub; color: var(--color-text-muted);
  font-size: .72rem; font-variant-numeric: tabular-nums; }

/* ---- fielder profile (/fielders/:id) ---- */
.profile-head { margin-bottom: var(--space_m); }
.profile-head .title { margin-bottom: var(--space_2xs); text-transform: none;
  letter-spacing: -.5px; }
.profile-meta { display: flex; flex-wrap: wrap; align-items: baseline;
  gap: .4em .75em; font-size: .9375rem; }
.profile-meta .pos-tag { border-radius: 2px; padding: .05em .45em;
  font-size: .75rem; font-weight: bold; letter-spacing: .5px;
  color: var(--color-text-accent);
  border: 1px solid color-mix(in oklch, var(--accent-color) 45%, transparent); }
.profile-meta .era { color: var(--color-text-muted); font-size: .8125rem; }
.stat-num .unit { font-size: 1rem; font-weight: 400; color: var(--color-text-muted); }
.panel-grid { display: grid; gap: var(--space_s);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  align-items: start; }
.panel-grid fieldset { margin: 0; }
.viz { width: 100%; height: auto; display: block; overflow: visible;
  font-family: var(--font-mono); }
.viz text { fill: var(--color-text-muted); }
.viz text.t-ink { fill: var(--color-text); }
.viz-cap { color: var(--color-text-muted); font-size: .75rem; margin: .5rem 0 0; }
.map-key { display: flex; flex-wrap: wrap; gap: .35em .9em; font-size: .75rem;
  margin-top: .5rem; color: var(--color-text-muted); }
.map-key .k { display: inline-flex; align-items: center; gap: .4em;
  white-space: nowrap; }
.map-key .swatch { width: .85em; height: .28em; border-radius: 1px;
  display: inline-block; }
.map-key .n { color: var(--color-text); font-variant-numeric: tabular-nums; }
.tier-rows { display: flex; flex-direction: column; gap: .5em; margin: 0; }
.tier-rows .row { display: flex; align-items: center; gap: .5em;
  font-size: .875rem; }
.tier-rows .lbl { min-width: 4.5em; color: var(--color-text-muted); }
.tier-rows .count { font-variant-numeric: tabular-nums; font-weight: 700; }
.tier-rows .bar { flex: 1; height: .55em; min-width: 0;
  background: color-mix(in oklch, var(--color-text) 8%, transparent);
  border-radius: 1px; overflow: hidden; }
.tier-rows .bar span { display: block; height: 100%; }
.tier-rows .high .bar span { background: var(--tier-high); }
.tier-rows .medium .bar span { background: var(--tier-medium); }
.tier-rows .low .bar span { background: var(--tier-low); }
.burned { display: flex; flex-wrap: wrap; gap: .5em .6em; margin: 0; padding: 0;
  list-style: none; }
.burned li { display: inline-flex; align-items: center; gap: .4em;
  font-size: .8125rem; }
.burned .x { color: var(--color-text-muted); font-variant-numeric: tabular-nums; }

/* ---- play permalink (/play/:id) ---- */
.share-frame { border: 1px solid var(--grid);
  background: color-mix(in oklch, var(--color-text) 3%, transparent);
  padding: .75rem; overflow-x: auto; }
.share-frame svg { display: block; width: 100%; height: auto; max-width: 640px;
  margin-inline: auto; }
.share-actions { display: flex; flex-wrap: wrap; gap: .6em var(--space_s);
  align-items: center; margin-top: .6rem; font-size: .8125rem;
  color: var(--color-text-muted); }
.share-actions .copy { border: 1px solid var(--base_03); border-radius: 2px;
  background: transparent; color: var(--color-text);
  font-family: var(--font-mono); font-size: .8125rem; cursor: pointer;
  padding: .3em .7em; }
.share-actions .copy:hover { border-color: var(--accent-color);
  color: var(--color-text-accent); }
.share-actions code { font-size: .75rem; word-break: break-all; }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
`;
