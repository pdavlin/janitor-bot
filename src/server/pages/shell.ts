/**
 * Page shell shared by every server-rendered page: full HTML document with
 * the header fieldset nav, main.flow content column, and the sticky footer
 * fieldset. Page modules supply only their body markup.
 */

import { THEME_CSS } from "./theme";
import { escapeHtml } from "./components";

/** Pages reachable from the header nav, in display order. */
export type NavPage = "home" | "highlights" | "season" | "about";

const NAV_ITEMS: ReadonlyArray<{ page: NavPage; href: string; label: string }> = [
  { page: "home", href: "/", label: "home" },
  { page: "highlights", href: "/highlights", label: "highlights" },
  { page: "season", href: "/season", label: "season" },
  { page: "about", href: "/about", label: "about" },
];

/** Inputs to the page shell. */
export interface PageShellOptions {
  /** Document title, e.g. "janitor-bot · season". */
  title: string;
  /** Which nav item to mark as the current page. */
  active: NavPage;
  /** Page body markup, rendered inside <main class="flow">. */
  body: string;
  /** Optional markup appended after the footer (tooltips, inline scripts). */
  tail?: string;
}

/** Renders one nav link, marking the active page with aria-current. */
function navLink(item: { page: NavPage; href: string; label: string }, active: NavPage): string {
  const current = item.page === active ? ' aria-current="page"' : "";
  return `<a class="nav-link" href="${item.href}"${current}>${item.label}</a>`;
}

/**
 * Wraps page body markup in the full HTML document: doctype, head with
 * charset/viewport/title/theme CSS, header nav, main, sticky footer.
 */
export function renderPage(options: PageShellOptions): string {
  const nav = NAV_ITEMS.map((item) => navLink(item, options.active)).join("\n      ");
  const tail = options.tail ? `\n${options.tail}` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${THEME_CSS}</style>
</head>
<body>
<header class="site-header">
  <fieldset class="nav-field">
    <legend>header</legend>
    <nav class="cluster" aria-label="primary">
      ${nav}
    </nav>
  </fieldset>
</header>
<main class="flow">
${options.body}
</main>
<footer class="site-footer">
  <fieldset class="foot-field-wrap">
    <legend>footer</legend>
    <div class="foot-field">
      <span>built with bun &middot; running on exe.dev</span>
      <a href="https://davlin.io">davlin.io</a>
    </div>
  </fieldset>
</footer>${tail}
</body>
</html>`;
}
