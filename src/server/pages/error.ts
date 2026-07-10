/**
 * Themed 500 page for the server-rendered HTML routes.
 *
 * Rendered when an HTML route (/ /highlights /season /about) throws while
 * building its response. It uses the shared shell — which needs no DB data —
 * so a failing page still comes back styled, navigable, and with the right
 * content type instead of a raw JSON error blob.
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
