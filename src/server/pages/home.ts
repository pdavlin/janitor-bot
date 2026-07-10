/**
 * GET / — home page: intro + about blurb, headline stat tiles, and the
 * three most recent high-tier plays with video.
 */

import type { StoredPlay } from "../../types/play";
import { renderPage } from "./shell";
import { formatShortDate, playCard, statTile } from "./components";

/** Data the home page renders from; assembled by the route handler. */
export interface HomePageData {
  totalPlays: number;
  highTierCount: number;
  /** Earliest play date (YYYY-MM-DD) or null when the DB is empty. */
  oldestPlay: string | null;
  /** Latest play date (YYYY-MM-DD) or null when the DB is empty. */
  newestPlay: string | null;
  /** Most recent high-tier plays with video, newest first. */
  recentPlays: StoredPlay[];
}

/** Context line for the high-tier tile ("clip-worthy arms, 38% of all plays"). */
function highTierContext(data: HomePageData): string {
  if (data.totalPlays === 0) return "no plays scored yet";
  const pct = Math.round((data.highTierCount / data.totalPlays) * 100);
  return `clip-worthy arms, ${pct}% of all plays`;
}

/** Season span tile value, e.g. "Mar 10 – Jun 23", or an em dash when empty. */
function seasonSpan(data: HomePageData): string {
  if (!data.oldestPlay || !data.newestPlay) return "&mdash;";
  return `${formatShortDate(data.oldestPlay)}&thinsp;&ndash;&thinsp;${formatShortDate(data.newestPlay)}`;
}

/** Renders the full home page HTML document. */
export function renderHomePage(data: HomePageData): string {
  const tiles = [
    statTile(
      "plays tracked",
      String(data.totalPlays),
      "outfield assists logged this season",
    ),
    statTile("high tier", String(data.highTierCount), highTierContext(data)),
    statTile(
      "season span",
      seasonSpan(data),
      data.oldestPlay
        ? "opening day through the latest game"
        : "waiting on the first detection",
      true,
    ),
  ].join("\n    ");

  const cards =
    data.recentPlays.length > 0
      ? data.recentPlays.map(playCard).join("\n\n      ")
      : `<p class="empty">no high-tier plays with video yet.</p>`;

  const body = `
  <div>
    <h1 class="title">janitor-bot</h1>
    <p class="tagline">A watcher for the game's quiet outs &mdash; it tracks every outfield
      assist across the MLB season and puts the best arms on tape.</p>
  </div>

  <fieldset>
    <legend>about</legend>
    <div class="prose">
      <p>janitor-bot combs each day's MLB games for outfield assists: the throws
        that cut a runner down on the bases.</p>
      <p>Every play gets scored and tiered high, medium, or low by how hard the
        situation and the throw were. The high-tier ones earn a video clip posted
        straight to Slack, so a great arm never slips by unnoticed.</p>
    </div>
  </fieldset>

  <div class="cluster tiles" role="list" aria-label="season stats">
    ${tiles}
  </div>

  <section class="flow" aria-labelledby="recent-h">
    <h2 id="recent-h" class="section-head">recent highlights</h2>

    <div class="cards flow" style="--flow-space: var(--space_s);">
      ${cards}
    </div>

    <a class="more" href="/highlights">more &rarr; highlights</a>
  </section>`;

  return renderPage({ title: "janitor-bot", active: "home", body });
}
