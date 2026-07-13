/**
 * GET /fielders/:id — one fielder's profile: header, stat tiles, mini
 * throw map, personal velocity strip against the league band, tier mix,
 * teams burned, and the three most recent plays as cards.
 *
 * Not in the nav; reached via the /season arm-leaderboard and
 * cannon-rankings name links.
 */

import type { StoredPlay } from "../../types/play";
import type {
  FielderProfile,
  TeamBurnCount,
  ThrowLane,
  VelocitySummary,
} from "../../storage/db";
import { renderPage } from "./shell";
import {
  dateSpan,
  emptyNote,
  escapeHtml,
  mph,
  playCard,
  statTile,
  teamBadge,
} from "./components";
import { baseColor, renderMiniThrowMap, renderVelocityStrip } from "./charts";

/** Data the fielder page renders from; assembled by the route handler. */
export interface FielderPageData {
  profile: FielderProfile;
  /** The fielder's (position, base) lanes for the mini throw map. */
  lanes: ThrowLane[];
  /** The fielder's measured velocities, ascending. */
  velocities: number[];
  /** League-wide velocity summary, for the muted context band. */
  league: VelocitySummary;
  /** Teams whose runners this fielder cut down, most-burned first. */
  teamsBurned: TeamBurnCount[];
  /** The fielder's most recent plays, newest first (up to three). */
  recentPlays: StoredPlay[];
}

/** Long-form position name for the era line ("CF" -> "center field"). */
function positionLong(position: string): string {
  if (position === "LF") return "left field";
  if (position === "CF") return "center field";
  if (position === "RF") return "right field";
  return position;
}

/** Profile header: name (not uppercase-forced), position tag, era line. */
function profileHead(profile: FielderProfile): string {
  const assists = `${profile.total} assist${profile.total === 1 ? "" : "s"} tracked`;
  return `<div class="profile-head">
    <h1 class="title">${escapeHtml(profile.fielderName)}</h1>
    <div class="profile-meta">
      <span class="pos-tag">${escapeHtml(profile.position)}</span>
      <span class="era">${escapeHtml(profile.team)} ${positionLong(profile.position)} &middot; ${assists}, ${dateSpan(profile.oldestPlay, profile.newestPlay)}</span>
    </div>
  </div>`;
}

/** Stat tiles: assists + rank, top throw (when measured), high-tier count. */
function statTiles(profile: FielderProfile): string {
  const tiles: string[] = [
    statTile(
      "assists tracked",
      String(profile.total),
      `#${profile.rank} of ${profile.fielderCount} fielders this season`,
    ),
  ];
  if (profile.maxVelocity != null && profile.measured > 0) {
    tiles.push(
      statTile(
        "top throw",
        `${mph(profile.maxVelocity)}<span class="unit"> mph</span>`,
        `measured on ${profile.measured} of ${profile.total} throw${profile.total === 1 ? "" : "s"}`,
      ),
    );
  }
  tiles.push(statTile("high tier", String(profile.high), "gold-standard cutdowns"));
  return `<section aria-label="season-to-date numbers">
    <div class="cluster tiles" role="list">
      ${tiles.join("\n      ")}
    </div>
  </section>`;
}

/** Mini throw map panel with the per-base count key. */
function throwMapPanel(data: FielderPageData): string {
  if (data.lanes.length === 0) {
    return `<fieldset>
      <legend>throw map</legend>
      ${emptyNote("no throws tracked yet.")}
    </fieldset>`;
  }

  const byBase = new Map<string, number>();
  for (const lane of data.lanes) {
    byBase.set(lane.base, (byBase.get(lane.base) ?? 0) + lane.count);
  }
  const keyOrder = ["Home", "2B", "3B", "1B"];
  const key = keyOrder
    .filter((base) => byBase.has(base))
    .map(
      (base) =>
        `<span class="k"><span class="swatch" style="background:${baseColor(base)}"></span>${base === "Home" ? "home" : base} <span class="n">${byBase.get(base)}</span></span>`,
    )
    .join("\n        ");

  const laneSummary = data.lanes
    .map((lane) => `${lane.count} to ${lane.base === "Home" ? "home" : lane.base}`)
    .join(", ");
  const aria = `Diamond showing ${data.profile.fielderName}'s throws: ${laneSummary}.`;

  return `<fieldset>
      <legend>throw map</legend>
      ${renderMiniThrowMap(data.lanes, aria)}
      <div class="map-key">
        ${key}
      </div>
    </fieldset>`;
}

/** Personal velocity strip panel against the muted league band. */
function velocityPanel(data: FielderPageData): string {
  const { profile, league } = data;
  if (
    data.velocities.length === 0 ||
    league.min == null ||
    league.max == null ||
    league.avg == null
  ) {
    return `<fieldset>
      <legend>arm velocity</legend>
      ${emptyNote("no measured throws yet.")}
    </fieldset>`;
  }

  const min = data.velocities[0]!;
  const max = data.velocities[data.velocities.length - 1]!;
  const aria = `${profile.fielderName}'s ${data.velocities.length} measured throws plotted on a miles-per-hour axis against the muted league range of ${mph(league.min)} to ${mph(league.max)} mph. The throws span ${mph(min)} to ${mph(max)} mph.`;

  return `<fieldset>
      <legend>arm velocity</legend>
      ${renderVelocityStrip(data.velocities, { min: league.min, max: league.max }, aria)}
      <p class="viz-cap">${data.velocities.length} throw${data.velocities.length === 1 ? "" : "s"} measured &middot; ${mph(min)}&ndash;${mph(max)} mph &middot; league avg ${mph(league.avg)}</p>
    </fieldset>`;
}

/** Tier-mix panel: one dot + bar row per tier. */
function tierMixPanel(profile: FielderProfile): string {
  const rows = (
    [
      ["high", profile.high],
      ["medium", profile.medium],
      ["low", profile.low],
    ] as const
  )
    .map(([tier, count]) => {
      const width =
        profile.total === 0 ? 0 : (count / profile.total) * 100;
      return `<div class="row ${tier}">
          <span class="tier tier-${tier}"><span class="dot" aria-hidden="true"></span></span>
          <span class="lbl">${tier}</span>
          <span class="bar"><span style="width:${width.toFixed(1)}%"></span></span>
          <span class="count">${count}</span>
        </div>`;
    })
    .join("\n        ");

  return `<fieldset>
      <legend>tier mix</legend>
      <div class="tier-rows">
        ${rows}
      </div>
    </fieldset>`;
}

/** Teams-burned mini list panel. */
function teamsBurnedPanel(teamsBurned: TeamBurnCount[]): string {
  if (teamsBurned.length === 0) {
    return `<fieldset>
      <legend>teams burned</legend>
      ${emptyNote("no runners cut down yet.")}
    </fieldset>`;
  }
  const items = teamsBurned
    .map(
      (team) =>
        `<li>${teamBadge(team.team)}<span class="x">&times;${team.count}</span></li>`,
    )
    .join("\n        ");
  return `<fieldset>
      <legend>teams burned</legend>
      <ul class="burned">
        ${items}
      </ul>
    </fieldset>`;
}

/** Renders the full fielder profile page HTML document. */
export function renderFielderPage(data: FielderPageData): string {
  const cards =
    data.recentPlays.length > 0
      ? data.recentPlays.map(playCard).join("\n\n    ")
      : emptyNote("no plays tracked yet.");

  const body = `
  ${profileHead(data.profile)}

  ${statTiles(data.profile)}

  <div class="panel-grid" style="margin-top:var(--space_s)">
    ${throwMapPanel(data)}

    ${velocityPanel(data)}

    ${tierMixPanel(data.profile)}

    ${teamsBurnedPanel(data.teamsBurned)}
  </div>

  <h2 class="section-head" style="margin-top:var(--space_m)">recent plays</h2>
  <div class="cards" style="margin-top:var(--space_2xs)">
    ${cards}
  </div>`;

  return renderPage({
    title: `janitor-bot · ${data.profile.fielderName}`,
    active: null,
    body,
  });
}
