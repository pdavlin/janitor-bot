/**
 * GET /highlights — full play gallery with server-side filters and paging.
 *
 * Filters are a plain GET form (no JavaScript): the selects mirror the
 * JSON API's tier/team/position/base filters and the current selection is
 * re-marked on every render. Paging is offset-based with a fixed page size.
 */

import type { StoredPlay, Tier } from "../../types/play";
import { renderPage } from "./shell";
import { BASE_OPTIONS, POSITION_OPTIONS, TIER_OPTIONS } from "../filter-options";
import { escapeHtml, playCard } from "./components";

/** Number of play cards per gallery page. */
export const HIGHLIGHTS_PAGE_SIZE = 14;

/**
 * Hard ceiling on how far back paging can reach, matching the JSON API's
 * 10000-row offset cap but snapped down to a page boundary so the clamp
 * lands on a real page (the largest multiple of the page size <= 10000).
 * The offset parser and the pager both derive from this, so the older
 * link vanishes exactly at the clamp instead of looping on itself.
 */
export const HIGHLIGHTS_MAX_OFFSET =
  Math.floor(10000 / HIGHLIGHTS_PAGE_SIZE) * HIGHLIGHTS_PAGE_SIZE;

/** Validated filter selection for the gallery (all optional). */
export interface HighlightsFilters {
  tier?: Tier;
  team?: string;
  position?: string;
  base?: string;
}

/**
 * The gallery's filter keys in form/query-string order — the single
 * enumeration driving the filter form, the pager's query strings, and the
 * empty-state copy.
 */
const FILTER_KEYS: readonly (keyof HighlightsFilters)[] = [
  "tier",
  "team",
  "position",
  "base",
];

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
  values: readonly string[],
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

/**
 * Option values per filter key. Tier/position/base come from the shared
 * filter domains; team's come from the DB at render time.
 */
function filterOptionValues(
  key: keyof HighlightsFilters,
  teams: string[],
): readonly string[] {
  switch (key) {
    case "tier":
      return TIER_OPTIONS;
    case "team":
      return teams;
    case "position":
      return POSITION_OPTIONS;
    case "base":
      return BASE_OPTIONS;
  }
}

/**
 * The four filter selects, driven by FILTER_KEYS: each select's label is
 * its key and its all-option is "all <key>s"; only the values vary.
 */
function filterSelects(data: HighlightsPageData): string {
  return FILTER_KEYS.map((key) =>
    filterSelect(
      key,
      key,
      `all ${key}s`,
      filterOptionValues(key, data.teams),
      data.filters[key],
    ),
  ).join("\n      ");
}

/** Serializes the active filters (and an optional offset) to a query string. */
function queryString(filters: HighlightsFilters, offset: number): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
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
  const olderOffset = data.offset + HIGHLIGHTS_PAGE_SIZE;
  if (olderOffset < data.total && olderOffset <= HIGHLIGHTS_MAX_OFFSET) {
    links.push(
      `<a href="${escapeHtml(queryString(data.filters, olderOffset))}">older &rarr;</a>`,
    );
  }
  if (links.length === 0) return "";
  return `\n  <nav class="pager" aria-label="pagination">${links.join("\n    ")}</nav>`;
}

/**
 * Empty-state copy. Three cases, most specific first:
 *   - paged past the last row (offset > 0): the newer link still applies,
 *     so tell the reader they've gone too far back, not that the DB is empty.
 *   - filters active on the first page: the filters are too narrow.
 *   - first page, no filters: the DB genuinely has nothing yet.
 */
function emptyState(data: HighlightsPageData): string {
  const filtered = FILTER_KEYS.some((key) => data.filters[key] !== undefined);
  let message: string;
  if (data.offset > 0) {
    message = "nothing this far back.";
  } else if (filtered) {
    message = "no plays match these filters.";
  } else {
    message = "no plays tracked yet.";
  }
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
      ${filterSelects(data)}
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
