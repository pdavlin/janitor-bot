/**
 * GET /play/:id — permalink page for a single play: the full play card
 * plus a share section with the standalone 1200×630 card SVG and a
 * copy-link affordance.
 *
 * Route naming: /play/:id (singular) is this HTML page; /plays/:id
 * (plural) remains the JSON API endpoint. The page carries og/twitter
 * meta pointing at /play/:id/card.svg so shared links unfurl with the
 * card image.
 */

import type { StoredPlay } from "../../types/play";
import { renderPage } from "./shell";
import { escapeHtml, mph, playCard } from "./components";
import { renderShareCardSvg } from "./share-card";

/**
 * Public origin used to build the absolute og:image / permalink URLs.
 * Social scrapers require absolute URLs, so this cannot be derived from
 * a relative path.
 */
export const SITE_ORIGIN = "https://janitor-bot.exe.xyz";

/** Human phrasing for the target base ("at home" vs "at 2B"). */
function baseText(targetBase: string): string {
  return targetBase === "Home" ? "home" : targetBase;
}

/** og:title, e.g. "Jac Caglianone (RF) cuts down Nick Sogard at home — 102.7 mph". */
function ogTitle(play: StoredPlay): string {
  const velocity =
    play.throwVelocity != null && play.throwVelocity > 0
      ? ` — ${mph(play.throwVelocity)} mph`
      : "";
  return `${play.fielderName} (${play.fielderPosition}) cuts down ${play.runnerName} at ${baseText(play.targetBase)}${velocity}`;
}

/** og:description: matchup, date, tier, and the credit chain. */
function ogDescription(play: StoredPlay): string {
  return `${play.awayTeam} @ ${play.homeTeam}, ${play.date} · ${play.tier}-tier outfield assist · ${play.creditChain}`;
}

/** The og/twitter meta block injected into the page <head>. */
function ogMeta(play: StoredPlay): string {
  const image = `${SITE_ORIGIN}/play/${play.id}/card.svg`;
  return [
    `<meta property="og:title" content="${escapeHtml(ogTitle(play))}">`,
    `<meta property="og:description" content="${escapeHtml(ogDescription(play))}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join("\n");
}

/** Progressive enhancement: the copy-link button writes to the clipboard. */
const COPY_SCRIPT = `<script>
(function () {
  "use strict";
  var button = document.querySelector(".share-actions .copy");
  if (!button || !navigator.clipboard) return;
  button.addEventListener("click", function () {
    navigator.clipboard.writeText(button.getAttribute("data-url")).then(function () {
      var original = button.textContent;
      button.textContent = "copied";
      setTimeout(function () { button.textContent = original; }, 1200);
    });
  });
})();
</script>`;

/** Renders the full play permalink page HTML document. */
export function renderPlayPage(play: StoredPlay): string {
  const permalink = `${SITE_ORIGIN}/play/${play.id}`;

  const body = `
  <h2 class="section-head">the play</h2>
  <div class="cards" style="margin-top:var(--space_2xs)">
    ${playCard(play)}
  </div>

  <fieldset class="share-field">
    <legend>share</legend>
    <div class="share-frame">
      ${renderShareCardSvg(play)}
    </div>
    <div class="share-actions">
      <button class="copy" type="button" data-url="${escapeHtml(permalink)}">copy link</button>
      <code>${escapeHtml(permalink)}</code>
    </div>
  </fieldset>`;

  return renderPage({
    title: `janitor-bot · play #${play.id}`,
    active: null,
    body,
    head: ogMeta(play),
    tail: COPY_SCRIPT,
  });
}
