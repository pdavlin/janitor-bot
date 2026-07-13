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
  CannonLeader,
  FielderLeader,
  MeasuredThrow,
  TeamBurnCount,
  ThrowLane,
  TierCount,
  VelocitySummary,
  WeeklyCount,
} from "../../storage/db";
import { renderPage } from "./shell";
import { dateSpan, emptyNote, escapeHtml, formatShortDate, mph, share } from "./components";
import {
  baseColor,
  renderBeeswarm,
  renderChartLegend,
  renderDataTable,
  renderHBarChart,
  renderMixChart,
  renderPositionStrips,
  renderThrowMap,
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
  /** Assist counts per (position, base) lane, for the throw map. */
  lanes: ThrowLane[];
  /** Top arms by peak measured velocity. */
  cannons: CannonLeader[];
  /** Every measured throw, velocity ascending. */
  throws: MeasuredThrow[];
  /** Velocity coverage and range across the season. */
  velocity: VelocitySummary;
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

/** Fixed base order for the throw-map/beeswarm swatch legends. */
const LEGEND_BASE_ORDER = ["Home", "2B", "3B", "1B"] as const;

/**
 * Thin-swatch base legend for the velocity charts, listing only the bases
 * present in the data, in fixed Home/2B/3B/1B order with lowercase labels.
 */
function baseSwatchLegend(present: ReadonlySet<string>): string {
  const items = LEGEND_BASE_ORDER.filter((base) => present.has(base)).map(
    (base) => ({ label: base.toLowerCase(), color: baseColor(base) }),
  );
  return renderChartLegend(items, "map-legend");
}

/** New section 1: the season throw map with its position×base table twin. */
function throwMapSection(data: SeasonPageData): string {
  const legend = "throw map";
  if (data.lanes.length === 0) return section(legend, null);

  const aria = `Bird's-eye diamond: ${data.totalPlays} outfield-assist throws, arcs colored by target base.`;
  return section(
    legend,
    `<p class="chart-note">Every tracked assist as an arc from its outfield zone to the
      base where the runner was retired. Denser lanes = more traffic.
      All ${data.totalPlays} plays.</p>
    ${renderThrowMap(data.lanes, aria)}
    ${baseSwatchLegend(new Set(data.lanes.map((lane) => lane.base)))}
    ${renderDataTable(
      ["position", "target base", "throws"],
      data.lanes.map((lane) => [lane.position, lane.base, String(lane.count)]),
    )}`,
  );
}

/** Bar scale floor for the cannon rankings, so ~90-103 differences read. */
const CANNON_FLOOR_MPH = 88;

/** New section 2: top 10 arms by single hardest measured throw. */
function cannonSection(data: SeasonPageData): string {
  const legend = "cannon rankings";
  if (data.cannons.length === 0 || data.velocity.max == null) {
    return section(legend, null);
  }

  const topMph = data.velocity.max;
  const items = data.cannons
    .map((cannon, i) => {
      const pct = Math.max(
        4,
        ((cannon.maxVelocity - CANNON_FLOOR_MPH) / (topMph - CANNON_FLOOR_MPH)) * 100,
      );
      return `<li>
        <span class="rank">${i + 1}</span>
        <span class="who"><a class="name" href="/fielders/${cannon.fielderId}">${escapeHtml(cannon.fielderName)}</a><span class="pos">${escapeHtml(cannon.position)}</span></span>
        <span class="cannon-metric">
          <div class="cannon-bar-track"><div class="cannon-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <span class="cannon-num">${mph(cannon.maxVelocity)}<span class="cannon-unit">mph</span></span>
        </span>
        <span class="cannon-sub">avg ${mph(cannon.avgVelocity)} &middot; ${cannon.throwCount} throw${cannon.throwCount === 1 ? "" : "s"}</span>
      </li>`;
    })
    .join("\n      ");

  const coveragePct =
    data.totalPlays === 0 ? 0 : Math.round((data.velocity.measured / data.totalPlays) * 100);

  return section(
    legend,
    `<p class="chart-note">Top ${data.cannons.length} arms by single hardest tracked throw.
      Hero number is peak mph; bar scaled from ${CANNON_FLOOR_MPH} mph.</p>
    <ol class="cannon">
      ${items}
    </ol>
    <p class="chart-note" style="margin-top:.6rem">Coverage: ${data.velocity.measured} of ${data.totalPlays} plays
      carry Statcast velocity (${coveragePct}%). Fielders with few tracked throws can
      rank high on a single laser.</p>`,
  );
}

/** Velocity histogram buckets for the beeswarm's data-table twin. */
const VELOCITY_BUCKETS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "under 70", min: -Infinity, max: 70 },
  { label: "70–79", min: 70, max: 80 },
  { label: "80–89", min: 80, max: 90 },
  { label: "90–94", min: 90, max: 95 },
  { label: "95+", min: 95, max: Infinity },
];

/** New section 3: the velocity-spread beeswarm with its bucket table twin. */
function velocitySpreadSection(data: SeasonPageData): string {
  const legend = "velocity spread";
  const velos = data.throws.map((t) => t.velocity);
  if (velos.length === 0 || data.velocity.min == null || data.velocity.max == null) {
    return section(legend, null);
  }

  const median = velos[Math.floor(velos.length / 2)]!;
  const aria = `Velocity spread: ${velos.length} measured throws on an mph axis, colored by target base.`;
  return section(
    legend,
    `<p class="chart-note">One dot per measured throw, placed on the mph axis, colored by
      target base. Min ${mph(data.velocity.min)} &middot; median ${mph(median)} &middot; max ${mph(data.velocity.max)} mph.</p>
    ${renderBeeswarm(data.throws, aria)}
    ${baseSwatchLegend(new Set(data.throws.map((t) => t.base)))}
    ${renderDataTable(
      ["velocity bucket", "throws"],
      VELOCITY_BUCKETS.map((bucket) => [
        bucket.label,
        String(velos.filter((v) => v >= bucket.min && v < bucket.max).length),
      ]),
    )}`,
  );
}

/** Positions in strip order, matching renderPositionStrips. */
const STRIP_POSITIONS = ["LF", "CF", "RF"] as const;

/** New section 4: per-position velocity strips with a summary table twin. */
function armByPositionSection(data: SeasonPageData): string {
  const legend = "arm by position";
  if (data.throws.length === 0) return section(legend, null);

  const rows = STRIP_POSITIONS.flatMap((position) => {
    const velos = data.throws
      .filter((t) => t.position === position)
      .map((t) => t.velocity);
    if (velos.length === 0) return [];
    const median = velos[Math.floor(velos.length / 2)]!;
    const max = velos[velos.length - 1]!;
    return [[position, String(velos.length), mph(median), mph(max)]];
  });

  return section(
    legend,
    `<p class="chart-note">Same mph axis, split by where the fielder stood.</p>
    ${renderPositionStrips(data.throws, "Throw velocity by fielding position, three mini dot strips sharing one mph axis.")}
    ${renderDataTable(["position", "throws", "median mph", "max mph"], rows)}`,
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
          <a class="name" href="/fielders/${leader.fielderId}">${escapeHtml(leader.fielderName)}</a>
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

  ${throwMapSection(data)}

  ${cannonSection(data)}

  ${velocitySpreadSection(data)}

  ${armByPositionSection(data)}

  ${leaderboardSection(data)}

  ${teamsSection(data)}`;

  return renderPage({
    title: "janitor-bot · season",
    active: "season",
    body,
    tail: `${TOOLTIP_HTML}\n${TOOLTIP_SCRIPT}`,
  });
}
