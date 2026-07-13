/**
 * GET /season — the four season charts, the arm leaderboard, and the
 * teams-most-burned list, all computed from the DB at request time.
 *
 * Color assignments follow the design brief's fixed slots: Home/direct on
 * slot 1, 2B/relay on slot 2, 3B on slot 3, anything else (legacy 1B rows)
 * on the slot-4 amber reserve. Tier bars use the single-hue ordinal ramp.
 */

import type {
  BaseCount,
  BaseThrowMix,
  FielderLeader,
  TeamBurnCount,
  TierCount,
  WeeklyCount,
} from "../../storage/db";
import { renderPage } from "./shell";
import { dateSpan, emptyNote, escapeHtml, formatShortDate, share } from "./components";
import {
  renderChartLegend,
  renderDataTable,
  renderHBarChart,
  renderMixChart,
  renderWeeklyChart,
  TOOLTIP_HTML,
  TOOLTIP_SCRIPT,
  type ChartRow,
} from "./charts";

/** Data the season page renders from; assembled by the route handler. */
export interface SeasonPageData {
  totalPlays: number;
  oldestPlay: string | null;
  newestPlay: string | null;
  weekly: WeeklyCount[];
  tiers: TierCount[];
  bases: BaseCount[];
  mix: BaseThrowMix[];
  leaders: FielderLeader[];
  teamsBurned: TeamBurnCount[];
}

/** Fixed categorical slot per target base (design brief, never cycled). */
function baseColor(base: string): string {
  if (base === "Home") return "var(--chart-1)";
  if (base === "2B") return "var(--chart-2)";
  if (base === "3B") return "var(--chart-3)";
  return "var(--chart-4)";
}

/** Season subhead, e.g. "378 outfield assists tracked · Mar 10 – Jun 23, 2026". */
function subhead(data: SeasonPageData): string {
  const count = `${data.totalPlays} outfield assist${data.totalPlays === 1 ? "" : "s"} tracked`;
  if (!data.oldestPlay || !data.newestPlay) return count;
  return `${count} &middot; ${dateSpan(data.oldestPlay, data.newestPlay)}`;
}

const EMPTY_NOTE = emptyNote("no data yet.");

/**
 * Wraps a section body in the page's standard fieldset + legend markup —
 * the same section-wrapper pattern as ops.ts's section(), with /season's
 * fieldset chrome. Pass null as the body for the shared empty state.
 */
function section(legend: string, body: string | null): string {
  return `<fieldset>
    <legend>${legend}</legend>
    ${body ?? EMPTY_NOTE}
  </fieldset>`;
}

/** Chart 1: plays per ISO week. */
function weeklySection(data: SeasonPageData): string {
  const legend = "plays per week";
  if (data.weekly.length === 0) return section(legend, null);

  const rows: ChartRow[] = data.weekly.map((w) => ({
    label: formatShortDate(w.weekStart),
    value: w.count,
    color: "var(--chart-1)",
  }));
  const values = rows.map((r) => r.value);
  const peak = rows.reduce((best, r) => (r.value > best.value ? r : best), rows[0]!);
  const aria = `Bar chart of plays tracked per week, ranging from ${Math.min(...values)} to ${Math.max(...values)}.`;

  return section(
    legend,
    `<p class="chart-note">Weekly count of tracked assists. Peak week begins ${escapeHtml(peak.label)}.</p>
    ${renderWeeklyChart(rows, aria)}
    ${renderDataTable(["week of", "plays"], rows.map((r) => [r.label, String(r.value)]))}`,
  );
}

/** Chart 2: tier distribution. */
function tierSection(data: SeasonPageData): string {
  const legend = "tier distribution";
  if (data.totalPlays === 0) return section(legend, null);

  const rows: ChartRow[] = data.tiers.map((t) => ({
    label: t.tier,
    value: t.count,
    color: `var(--tier-${t.tier})`,
  }));
  const aria = `Horizontal bar chart of plays by tier: ${data.tiers
    .map((t) => `${t.tier} ${t.count}`)
    .join(", ")}.`;

  return section(
    legend,
    `<p class="chart-note">Assists by scored tier. Ramp runs high &rarr; low off the accent.</p>
    ${renderHBarChart(rows, "plays", aria)}
    ${renderDataTable(
      ["tier", "plays", "share"],
      data.tiers.map((t) => [t.tier, String(t.count), share(t.count, data.totalPlays, 1)]),
    )}`,
  );
}

/** Chart 3: target base breakdown. */
function baseSection(data: SeasonPageData): string {
  const legend = "target base breakdown";
  if (data.bases.length === 0) return section(legend, null);

  const rows: ChartRow[] = data.bases.map((b) => ({
    label: b.base,
    value: b.count,
    color: baseColor(b.base),
  }));
  const aria = `Horizontal bar chart of plays by target base: ${data.bases
    .map((b) => `${b.base} ${b.count}`)
    .join(", ")}.`;

  return section(
    legend,
    `<p class="chart-note">Which base the runner was cut down at. The colors below key
      the base for this chart only; the direct-vs-relay chart reuses the same
      swatches for its own two series and carries its own legend.</p>
    ${renderHBarChart(rows, "target", aria)}
    ${renderChartLegend(rows.map((r) => ({ label: r.label, color: r.color })))}
    ${renderDataTable(
      ["target base", "plays", "share"],
      data.bases.map((b) => [b.base, String(b.count), share(b.count, data.totalPlays, 1)]),
    )}`,
  );
}

/** Chart 4: direct vs relay per target base. */
function mixSection(data: SeasonPageData): string {
  const legend = "direct vs relay";
  if (data.mix.length === 0) return section(legend, null);

  const rows = data.mix.map((m) => ({
    label: m.base,
    direct: m.direct,
    relay: m.relay,
  }));

  return section(
    legend,
    `<p class="chart-note">Share of each base's assists made on a single throw (direct)
      versus a relay chain. Bars are 100% of that base's plays.</p>
    ${renderMixChart(rows, "100 percent stacked bars of direct versus relay throws per target base.")}
    ${renderChartLegend([
      { label: "direct", color: "var(--chart-1)" },
      { label: "relay", color: "var(--chart-2)" },
    ])}
    ${renderDataTable(
      ["target base", "direct", "relay", "relay %"],
      data.mix.map((m) => {
        const total = m.direct + m.relay;
        const relayPct = total === 0 ? "0%" : `${Math.round((m.relay / total) * 100)}%`;
        return [m.base, String(m.direct), String(m.relay), relayPct];
      }),
    )}`,
  );
}

/** Arm leaderboard: rank, name, position, count bar, tier-mix dot counts. */
function leaderboardSection(data: SeasonPageData): string {
  const legend = "arm leaderboard";
  if (data.leaders.length === 0) return section(legend, null);

  const maxTotal = data.leaders[0]!.total;
  const list = data.leaders
    .map((leader, i) => {
      const widthPct = maxTotal === 0 ? "0%" : `${((leader.total / maxTotal) * 100).toFixed(1)}%`;
      const tierMix = (
        [
          ["high", leader.high],
          ["medium", leader.medium],
          ["low", leader.low],
        ] as const
      )
        .map(
          ([tier, count]) =>
            `<span><i class="dot" style="background:var(--tier-${tier})" aria-hidden="true"></i>${count}</span>`,
        )
        .join("");
      return `<li>
        <span class="rank">${i + 1}</span>
        <div class="who">
          <span class="name">${escapeHtml(leader.fielderName)}</span>
          <span class="pos">${escapeHtml(leader.position)}</span>
        </div>
        <div class="metric">
          <div class="bar-track"><div class="bar-fill" style="width:${widthPct}"></div></div>
          <span class="count">${leader.total}</span>
          <div class="tiermix">${tierMix}</div>
        </div>
      </li>`;
    })
    .join("\n      ");

  return section(
    legend,
    `<p class="chart-note">Most tracked assists by fielder. Bar shows count; dots show
      tier mix (high / medium / low).</p>
    <ol class="lb">
      ${list}
    </ol>
    <div class="legend" style="margin-top:.7rem">
      <span><i class="dot" style="background:var(--tier-high)"></i>high</span>
      <span><i class="dot" style="background:var(--tier-medium)"></i>medium</span>
      <span><i class="dot" style="background:var(--tier-low)"></i>low</span>
    </div>`,
  );
}

/** Teams most burned: runner's team, thin bar, count. */
function teamsSection(data: SeasonPageData): string {
  const legend = "teams most burned";
  if (data.teamsBurned.length === 0) return section(legend, null);

  const maxCount = data.teamsBurned[0]!.count;
  const list = data.teamsBurned
    .map((team) => {
      const widthPct = maxCount === 0 ? "0%" : `${((team.count / maxCount) * 100).toFixed(1)}%`;
      return `<li>
        <span class="abbr">${escapeHtml(team.team)}</span>
        <div class="tbar-track"><div class="tbar-fill" style="width:${widthPct}"></div></div>
        <span class="tn">${team.count}</span>
      </li>`;
    })
    .join("\n      ");

  return section(
    legend,
    `<p class="chart-note">Runners cut down, counted by the runner's team. Runner team
      is the batting side: away in the top half, home in the bottom.</p>
    <ol class="teams">
      ${list}
    </ol>`,
  );
}

/** Renders the full season page HTML document. */
export function renderSeasonPage(data: SeasonPageData): string {
  const body = `
  <div>
    <h1 class="title">season</h1>
    <p class="subhead">${subhead(data)}</p>
  </div>

  ${weeklySection(data)}

  ${tierSection(data)}

  ${baseSection(data)}

  ${mixSection(data)}

  ${leaderboardSection(data)}

  ${teamsSection(data)}`;

  return renderPage({
    title: "janitor-bot · season",
    active: "season",
    body,
    tail: `${TOOLTIP_HTML}\n${TOOLTIP_SCRIPT}`,
  });
}
