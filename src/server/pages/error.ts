/**
 * Themed error pages for the server-rendered HTML routes.
 *
 * The 500 page renders when an HTML route throws while building its
 * response; the 404 page renders when an HTML page route's subject (a
 * fielder id, a play id) doesn't exist. Both use the shared shell — which
 * needs no DB data — so a failing page still comes back styled, navigable,
 * and with the right content type instead of a raw JSON error blob.
 */

import { renderPage } from "./shell";

/** Full HTML document for the generic 500 state. Built once, DB-free. */
export function renderErrorPage(): string {
  const body = `
  <h1 class="title">something broke</h1>
  <p class="lede">The server hit an unexpected error building this page. It has
    been logged. Try again in a moment.</p>
  <p><a class="more" href="/">&larr; back to home</a></p>`;

  return renderPage({
    title: "janitor-bot · error",
    active: null,
    body,
  });
}

/**
 * Full HTML document for the 404 state on the HTML page routes (unknown
 * fielder id or play id). Built once, DB-free.
 */
export function renderNotFoundPage(): string {
  const body = `
  <h1 class="title">nothing here</h1>
  <p class="lede">No tracked play or fielder lives at this address. The season
    moves fast &mdash; the id may be wrong, or the page may never have existed.</p>
  <p><a class="more" href="/">&larr; back to home</a></p>`;

  return renderPage({
    title: "janitor-bot · not found",
    active: null,
    body,
  });
}
