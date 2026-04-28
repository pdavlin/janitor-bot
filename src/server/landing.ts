/**
 * Static HTML landing page served at GET /.
 *
 * Visually matches davlin.io: base16 palette, monospace, fieldset/legend
 * structure, light/dark via prefers-color-scheme.
 */

export const LANDING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>janitor-bot</title>
<style>
*,*::before,*::after{box-sizing:border-box}
html{-moz-text-size-adjust:none;-webkit-text-size-adjust:none;text-size-adjust:none}
body,h1,h2,h3,h4,p,figure,blockquote,dl,dd{margin-block-end:0}
body{line-height:1.5}
h1,h2,h3,h4{line-height:1.1;margin:0;text-wrap:balance}
a:not([class]){text-decoration-skip-ink:auto;color:currentColor}

:root{
  --base_01:#292424;
  --base_02:#585050;
  --base_03:#655d5d;
  --base_07:#f4ecec;
  --base_0b:#4b8b8b;
  --space_m:clamp(1.5rem,1.4348rem + 0.3261vw,1.6875rem);
  --space_l:clamp(2rem,1.913rem + 0.4348vw,2.25rem);
  --space_xl:clamp(3rem,2.8696rem + 0.6522vw,3.375rem);
  --page_gutters:clamp(var(--space_m),3vw,var(--space_xl));
  --page-max:44rem;
  --color-bg:var(--base_07);
  --color-text:var(--base_01);
  --accent-color:var(--base_0b);
  --color-highlight:color-mix(in oklch,var(--accent-color) 30%,var(--color-bg));
}

@media (prefers-color-scheme: dark){
  :root{--color-bg:var(--base_01);--color-text:var(--base_07)}
}

body{
  background:var(--color-bg);
  color:var(--color-text);
  font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
  margin:0;
}

::selection{background:var(--color-highlight);color:var(--color-text)}

a{text-decoration-color:var(--accent-color)}
a:hover{text-decoration-color:var(--accent-color)}

:focus-visible{
  outline:none;
  box-shadow:0 0 0 2px var(--accent-color),0 0 0 4px var(--color-bg),0 0 0 6px var(--color-text);
}

fieldset{
  border:1px solid var(--base_03);
  padding:0.75rem 1rem;
  margin:1rem 0;
  transition:border-color 0.15s ease-out;
}
fieldset:hover,fieldset:focus-within{border-color:var(--accent-color)}

fieldset legend{
  padding:0 0.5em;
  color:var(--base_02);
  font-weight:bold;
  font-size:0.75rem;
  text-transform:lowercase;
  transition:color 0.15s ease-out;
}
fieldset:hover legend,fieldset:focus-within legend{color:var(--accent-color)}

.site-header{
  display:flex;
  justify-content:flex-end;
  padding-inline:var(--page_gutters);
  margin-block:var(--page_gutters) var(--space_xl);
}
.site-header fieldset{margin:0;padding:0.25rem 0.5rem}
.site-header a{color:currentcolor;text-decoration:none}
.site-header a:hover{text-decoration:underline}

main{
  --gutter-max:calc(1rem + 10vw);
  --gap:var(--space_m);
  --content:min(var(--page-max),100% - var(--gap) * 2);
  --gutter:minmax(var(--gap),var(--gutter-max));
  display:grid;
  grid-template-columns:[full-start] 0px [gutter-start] var(--gutter) [content-start] var(--content) [content-end] var(--gutter) [gutter-end] 1fr [full-end];
}
main > *{grid-column:content-start/content-end}
main > * + *{margin-block-start:var(--space_m)}

.title{
  font-size:2.5rem;
  letter-spacing:1.25px;
  margin-bottom:var(--space_m);
}

.about-group p{margin:0.75rem 0}
.about-group p:first-of-type{margin-top:0}
.about-group p:last-of-type{margin-bottom:0}

.about-group ul{padding-left:1.25rem;margin:0.5rem 0}
.about-group li{margin:0.35rem 0}

code{
  font-family:inherit;
  background:color-mix(in oklch,var(--accent-color) 12%,var(--color-bg));
  padding:0.05em 0.35em;
  border-radius:2px;
}

footer{
  padding:var(--page_gutters);
  text-align:center;
  color:var(--base_02);
  font-size:0.85rem;
  margin-top:var(--space_xl);
}
</style>
</head>
<body>
<header class="site-header">
  <fieldset>
    <legend>service</legend>
    <span>janitor-bot</span>
  </fieldset>
</header>
<main>
  <h1 class="title">janitor-bot</h1>
  <p>An MLB outfield assist tracker. Polls the Stats API on a schedule, ranks each throw by quality, matches it to a Baseball Savant clip, and pings Slack when something good happens.</p>

  <fieldset class="about-group">
    <legend>about</legend>
    <p>Detects runners thrown out by an outfielder (LF / CF / RF) and tiers each play as <strong>high</strong>, <strong>medium</strong>, or <strong>low</strong> based on the difficulty of the throw, the leverage of the situation, and whether a relay was involved.</p>
    <p>Data lives in a small SQLite database and is exposed through a JSON API. A background daemon polls live and recently-final games every 30 minutes and pushes notifications for any new detections.</p>
  </fieldset>

  <fieldset class="about-group">
    <legend>endpoints</legend>
    <ul>
      <li><a href="/plays">GET /plays</a> &mdash; paginated, filterable list</li>
      <li><a href="/plays/today">GET /plays/today</a> &mdash; just today's plays</li>
      <li><code>GET /plays/:id</code> &mdash; a single play by id</li>
      <li><a href="/stats">GET /stats</a> &mdash; aggregated stats</li>
      <li><a href="/health">GET /health</a> &mdash; service health and DB info</li>
    </ul>
  </fieldset>

  <fieldset class="about-group">
    <legend>links</legend>
    <ul>
      <li><a href="https://davlin.io">davlin (dot) io</a></li>
    </ul>
  </fieldset>
</main>
<footer>built with bun &middot; running on exe.dev</footer>
</body>
</html>`;
