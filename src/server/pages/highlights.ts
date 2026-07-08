/**
 * GET /highlights — full play gallery with server-side filters and paging.
 *
 * Filters are a plain GET form (no JavaScript): the selects mirror the
 * JSON API's tier/team/position/base filters and the current selection is
 * re-marked on every render. Paging is offset-based with a fixed page size.
 */

import type { StoredPlay, Tier } from "../../types/play";
import { renderPage } from "./shell";
import { escapeHtml, playCard } from "./components";

/** Number of play cards per gallery page. */
export const HIGHLIGHTS_PAGE_SIZE = 14;

/** Validated filter selection for the gallery (all optional). */
export interface HighlightsFilters {
  tier?: Tier;
  team?: string;
  position?: string;
  base?: string;
}

/** Data the highlights page renders from; assembled by the route handler. */
export interface HighlightsPageData {
  /** Plays for the current page, already filtered and paginated. */
  plays: StoredPlay[];
  /** Total plays matching the filters, ignoring paging. */
  total: number;
  offset: number;
  filters: HighlightsFilters;
  /** Every team abbreviation in the DB, for the team select. */
  teams: string[];
}

/** Renders one option, marking it selected when it matches the current value. */
function option(value: string, label: string, current: string | undefined): string {
  const selected = value === (current ?? "") ? " selected" : "";
  return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
}

/** Renders one labelled select for the filter form. */
function filterSelect(
  name: string,
  label: string,
  allLabel: string,
  values: string[],
  current: string | undefined,
): string {
  const options = [
    option("", allLabel, current),
    ...values.map((v) => option(v, v, current)),
  ].join("\n          ");
  return `<label class="filter">
        <span>${escapeHtml(label)}</span>
        <select name="${escapeHtml(name)}">
          ${options}
        </select>
      </label>`;
}

/** Serializes the active filters (and an optional offset) to a query string. */
function queryString(filters: HighlightsFilters, offset: number): string {
  const params = new URLSearchParams();
  if (filters.tier) params.set("tier", filters.tier);
  if (filters.team) params.set("team", filters.team);
  if (filters.position) params.set("position", filters.position);
  if (filters.base) params.set("base", filters.base);
  if (offset > 0) params.set("offset", String(offset));
  const qs = params.toString();
  return qs === "" ? "/highlights" : `/highlights?${qs}`;
}

/** Renders the newer/older pager links, preserving the active filters. */
function pager(data: HighlightsPageData): string {
  const links: string[] = [];
  if (data.offset > 0) {
    const newerOffset = Math.max(0, data.offset - HIGHLIGHTS_PAGE_SIZE);
    links.push(
      `<a href="${escapeHtml(queryString(data.filters, newerOffset))}">&larr; newer</a>`,
    );
  }
  if (data.offset + HIGHLIGHTS_PAGE_SIZE < data.total) {
    const olderOffset = data.offset + HIGHLIGHTS_PAGE_SIZE;
    links.push(
      `<a href="${escapeHtml(queryString(data.filters, olderOffset))}">older &rarr;</a>`,
    );
  }
  if (links.length === 0) return "";
  return `\n  <nav class="pager" aria-label="pagination">${links.join("\n    ")}</nav>`;
}

/** Empty-state copy: distinguishes a fresh DB from over-narrow filters. */
function emptyState(data: HighlightsPageData): string {
  const filtered =
    data.filters.tier !== undefined ||
    data.filters.team !== undefined ||
    data.filters.position !== undefined ||
    data.filters.base !== undefined;
  const message = filtered
    ? "no plays match these filters."
    : "no plays tracked yet.";
  return `<p class="empty">${message}</p>`;
}

/** Renders the full highlights page HTML document. */
export function renderHighlightsPage(data: HighlightsPageData): string {
  const cards =
    data.plays.length > 0
      ? `<section class="gallery" aria-label="plays">\n\n    ${data.plays
          .map(playCard)
          .join("\n\n    ")}\n\n  </section>`
      : emptyState(data);

  const body = `
  <h1 class="title">highlights</h1>

  <fieldset class="filters">
    <legend>filters</legend>
    <form method="get" action="/highlights" class="cluster">
      ${filterSelect("tier", "tier", "all tiers", ["high", "medium", "low"], data.filters.tier)}
      ${filterSelect("team", "team", "all teams", data.teams, data.filters.team)}
      ${filterSelect("position", "position", "all positions", ["LF", "CF", "RF"], data.filters.position)}
      ${filterSelect("base", "base", "all bases", ["2B", "3B", "Home"], data.filters.base)}
      <button class="filter-apply" type="submit">apply</button>
    </form>
  </fieldset>

  ${cards}${pager(data)}`;

  return renderPage({
    title: "janitor-bot · highlights",
    active: "highlights",
    body,
  });
}
