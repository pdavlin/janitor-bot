/**
 * GET /ops — internal dashboard: vote engagement and pipeline health.
 *
 * Public but deliberately unlinked from the header nav (shell.ts keeps its
 * four-item NAV_ITEMS; this page passes active: null). Two sections only,
 * per the approved mockup: engagement (vote tiles, most-loved list,
 * disputed list) and pipeline health (fetch-status chart, rematch decision
 * bars, totals tiles). The weekly-review agent tables (agent_runs,
 * agent_findings) are intentionally not read here.
 */

import type {
  FetchStatusCount,
  PipelineTotals,
  RematchDecisionCount,
  TierCount,
  VotedPlay,
  VoteEngagement,
} from "../../storage/db";
import { renderPage } from "./shell";
import { escapeHtml, formatShortDate, statTile, tierBadge, yearOf } from "./components";
import {
  renderDataTable,
  renderHBarChart,
  TOOLTIP_HTML,
  TOOLTIP_SCRIPT,
  type ChartRow,
} from "./charts";

/** Data the ops page renders from; assembled by the route handler. */
export interface OpsPageData {
  engagement: VoteEngagement;
  loved: VotedPlay[];
  flagged: VotedPlay[];
  fetchStatuses: FetchStatusCount[];
  rematchDecisions: RematchDecisionCount[];
  totals: PipelineTotals;
  tiers: TierCount[];
  oldestPlay: string | null;
  newestPlay: string | null;
}

const EMPTY_NOTE = (text: string): string => `<p class="empty">${text}</p>`;

/** Percentage share of total as a whole number (mockup style: "64%"). */
function share(count: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((count / total) * 100)}%`;
}

/** Signed net score with a typographic minus, e.g. "+3" / "−2". */
function formatNet(net: number): string {
  return net < 0 ? `−${Math.abs(net)}` : `+${net}`;
}

/** Fire/trash/net tally, shared by the most-loved and disputed lists. */
function voteTally(play: VotedPlay): string {
  return `<span class="vtally"><span class="up">\u{1F525} ${play.fireCount}</span><span class="dn">\u{1F5D1} ${play.trashCount}</span><span class="net">${formatNet(play.netScore)}</span></span>`;
}

/** Headline fragment: "Name (POS) ⟶ Base · cut down Runner" (pre-escaped). */
function playHeadline(play: VotedPlay): string {
  return `${escapeHtml(play.fielderName)} <span class="pos">(${escapeHtml(play.fielderPosition)})</span><span class="arrow">&#10230;</span>${escapeHtml(play.targetBase)} <span class="cut">&middot; cut down ${escapeHtml(play.runnerName)}</span>`;
}

// ---------------------------------------------------------------------------
// Engagement section
// ---------------------------------------------------------------------------

/** The three engagement stat tiles. */
function engagementTiles(engagement: VoteEngagement): string {
  const tiles = [
    statTile(
      "votes cast",
      String(engagement.totalVotes),
      `\u{1F525} ${engagement.fireTotal} · \u{1F5D1} ${engagement.trashTotal} across ${engagement.playsVotedOn} plays`,
    ),
    statTile(
      "plays voted on",
      String(engagement.playsVotedOn),
      `of ${engagement.totalSnapshots} tier-review snapshots taken`,
    ),
    statTile(
      "distinct voters",
      String(engagement.distinctVoters),
      "private beta channel — small n, read signal loosely",
    ),
  ].join("\n      ");

  return `<div class="cluster tiles" role="list" aria-label="engagement totals">
      ${tiles}
    </div>`;
}

/** Most-loved list: rank, headline, tier/chain/matchup sub-line, tally. */
function mostLovedSection(loved: VotedPlay[]): string {
  if (loved.length === 0) {
    return `<div>
      <p class="section-head">most loved &middot; top net score</p>
      ${EMPTY_NOTE("no plays with a positive net score yet.")}
    </div>`;
  }

  const items = loved
    .map(
      (play, i) => `<li>
        <span class="rk">${i + 1}</span>
        <span class="play">
          <span class="hl">${playHeadline(play)}</span>
          <span class="sub">${tierBadge(play.tier)}
            <span class="chain-mini">${escapeHtml(play.creditChain)}</span> &middot;
            ${escapeHtml(play.awayTeam)} @ ${escapeHtml(play.homeTeam)}</span>
        </span>
        ${voteTally(play)}
      </li>`,
    )
    .join("\n      ");

  return `<div>
      <p class="section-head">most loved &middot; top net score</p>
      <ol class="loved">
      ${items}
      </ol>
    </div>`;
}

/**
 * Human-readable tier-review reason. Known snapshot reasons get the
 * mockup's copy; anything else falls back to the escaped raw value.
 */
function flagReason(play: VotedPlay): string {
  const voters = `${play.voterCount} voter${play.voterCount === 1 ? "" : "s"}`;
  const known: Record<string, string> = {
    channel_disagrees_high_or_medium:
      "channel disagrees — voted down a high/medium tier",
    channel_disagrees_low: "channel disagrees — boosted a low tier",
  };
  const reason = play.tierReviewReason
    ? known[play.tierReviewReason] ?? escapeHtml(play.tierReviewReason)
    : "flagged for tier review";
  return `${reason} &middot; ${voters}`;
}

/** Disputed list: snapshots flagged for tier review. */
function disputedSection(flagged: VotedPlay[]): string {
  if (flagged.length === 0) {
    return `<div>
      <p class="section-head">disputed &middot; flagged for tier review</p>
      ${EMPTY_NOTE("nothing flagged for tier review.")}
    </div>`;
  }

  const items = flagged
    .map(
      (play) => `<li>
        <div class="top">
          ${tierBadge(play.tier)}
          <span class="name">${playHeadline(play)}</span>
          ${voteTally(play)}
        </div>
        <div class="reason">${flagReason(play)}</div>
      </li>`,
    )
    .join("\n      ");

  return `<div>
      <p class="section-head">disputed &middot; flagged for tier review (${flagged.length})</p>
      <ul class="disp">
      ${items}
      </ul>
    </div>`;
}

/** The full engagement fieldset. */
function engagementSection(data: OpsPageData): string {
  return `<fieldset class="grp">
    <legend>engagement</legend>
    <div class="flow">
    ${engagementTiles(data.engagement)}

    ${mostLovedSection(data.loved)}

    ${disputedSection(data.flagged)}
    </div>
  </fieldset>`;
}

// ---------------------------------------------------------------------------
// Pipeline health section
// ---------------------------------------------------------------------------

/** Chart color per fetch status; statuses beyond the mockup's three get
 *  the reserve amber slot. Trusted CSS expressions, never DB-sourced. */
function fetchStatusColor(status: string): string {
  if (status === "success") return "var(--base_0b)";
  if (status === "unfetched") return "var(--base_03)";
  if (status === "no_video_found") return "var(--accent-color)";
  return "var(--chart-4)";
}

/** Short chart label per fetch status ("no_video_found" -> "no video"). */
function fetchStatusLabel(status: string): string {
  if (status === "no_video_found") return "no video";
  return status.replaceAll("_", " ");
}

/** Data-table label per fetch status (NULL bucket named explicitly). */
function fetchStatusTableLabel(status: string): string {
  return status === "unfetched" ? "unfetched (null)" : status;
}

/** Video fetch-status chart with its data-table twin. */
function fetchStatusSection(data: OpsPageData): string {
  const { fetchStatuses, totals } = data;
  if (fetchStatuses.length === 0) {
    return `<div>
      <p class="section-head">video fetch status</p>
      ${EMPTY_NOTE("no plays tracked yet.")}
    </div>`;
  }

  const rows: ChartRow[] = fetchStatuses.map((s) => ({
    label: fetchStatusLabel(s.status),
    value: s.count,
    color: fetchStatusColor(s.status),
  }));
  const aria = `Fetch status: ${fetchStatuses
    .map((s) => `${fetchStatusLabel(s.status)} ${s.count}`)
    .join(", ")}.`;

  const unfetched = fetchStatuses.find((s) => s.status === "unfetched")?.count ?? 0;
  const unfetchedClause =
    unfetched > 0
      ? `the ${unfetched} unfetched pre-date the fetch_status column; `
      : "";
  const note = `${unfetchedClause}${totals.withVideo} of ${totals.totalPlays} plays carry a video link.`;

  return `<div>
      <p class="section-head">video fetch status &middot; ${totals.totalPlays} plays</p>
      <p class="chart-note">outcome of the highlight-video lookup per play.</p>
      ${renderHBarChart(rows, "plays", aria)}
      <p class="ops-note">${note}</p>
      ${renderDataTable(
        ["status", "plays", "share"],
        fetchStatuses.map((s) => [
          fetchStatusTableLabel(s.status),
          String(s.count),
          share(s.count, totals.totalPlays),
        ]),
      )}
    </div>`;
}

/**
 * Display metadata per rematch decision. Positive outcomes carry their own
 * color class; every other decision (agreed, deduped, errors) is neutral.
 */
function decisionMeta(decision: string): { label: string; cssClass: string } {
  if (decision === "angle_found") return { label: "angle found", cssClass: "dec-found" };
  if (decision === "swapped") return { label: "swapped", cssClass: "dec-swap" };
  return { label: decision.replaceAll("_", " "), cssClass: "dec-none" };
}

/** Rematch and angle decision bars with the inline color legend. */
function rematchSection(decisions: RematchDecisionCount[]): string {
  if (decisions.length === 0) {
    return `<div>
      <p class="section-head">rematch &amp; angle decisions</p>
      ${EMPTY_NOTE("no rematch or angle requests yet.")}
    </div>`;
  }

  const totalEvents = decisions.reduce((sum, d) => sum + d.count, 0);
  const maxCount = decisions[0]!.count;
  const items = decisions
    .map((d) => {
      const meta = decisionMeta(d.decision);
      const widthPct = maxCount === 0 ? "0%" : `${((d.count / maxCount) * 100).toFixed(1)}%`;
      return `<li class="${meta.cssClass}">
        <span class="k"><span class="dot" aria-hidden="true"></span>${escapeHtml(meta.label)}</span>
        <span class="dec-track"><span class="dec-fill" style="width:${widthPct}"></span></span>
        <span class="n">${d.count}</span>
      </li>`;
    })
    .join("\n      ");

  return `<div>
      <p class="section-head">rematch &amp; angle decisions &middot; ${totalEvents} event${totalEvents === 1 ? "" : "s"}</p>
      <p class="chart-note">when a viewer reports a wrong or missing clip, the agent re-searches.</p>
      <ul class="decs">
      ${items}
      </ul>
      <div class="legend-inline">
        <span><span class="dot" style="background:var(--base_0b)"></span>a better angle was posted</span>
        <span><span class="dot" style="background:var(--accent-color)"></span>original clip replaced</span>
        <span><span class="dot" style="background:var(--base_03)"></span>nothing found</span>
      </div>
    </div>`;
}

/** Context line for the throw-velocity tile, honest about the zero state. */
function velocityContext(totals: PipelineTotals): string {
  if (totals.withVelocity > 0) {
    return `of ${totals.totalPlays} plays have a measured velo`;
  }
  if (totals.velocityNoMatch > 0) {
    const lookups = `${totals.velocityNoMatch} lookup${totals.velocityNoMatch === 1 ? "" : "s"}`;
    return `statcast velo not yet backfilled · ${lookups}, all no-match`;
  }
  return "statcast velo not yet backfilled";
}

/** The three pipeline-totals stat tiles. */
function totalsSection(data: OpsPageData): string {
  const { totals, tiers } = data;
  const tierContext = tiers.map((t) => `${t.tier} ${t.count}`).join(" · ");
  const tiles = [
    statTile(
      "overturned plays",
      String(totals.overturned),
      "out stood on a challenge review · tier −2 applied",
    ),
    statTile("throw velocity", String(totals.withVelocity), velocityContext(totals)),
    statTile(
      "tracked plays",
      String(totals.totalPlays),
      `${totals.distinctGames} game${totals.distinctGames === 1 ? "" : "s"} · ${tierContext}`,
    ),
  ].join("\n      ");

  return `<div>
      <p class="section-head">totals</p>
      <div class="cluster tiles" role="list" aria-label="pipeline totals">
      ${tiles}
      </div>
    </div>`;
}

/** The full pipeline-health fieldset. */
function pipelineSection(data: OpsPageData): string {
  return `<fieldset class="grp">
    <legend>pipeline health</legend>
    <div class="flow">
    ${fetchStatusSection(data)}

    ${rematchSection(data.rematchDecisions)}

    ${totalsSection(data)}
    </div>
  </fieldset>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Coverage line, e.g. "378 plays across 333 games · Mar 10 – Jun 23, 2026". */
function coverageNote(data: OpsPageData): string {
  const { totals } = data;
  const counts = `${totals.totalPlays} play${totals.totalPlays === 1 ? "" : "s"} across ${totals.distinctGames} game${totals.distinctGames === 1 ? "" : "s"}`;
  if (!data.oldestPlay || !data.newestPlay) return counts;
  const year = yearOf(data.newestPlay);
  const span = `${formatShortDate(data.oldestPlay)} &ndash; ${formatShortDate(data.newestPlay)}${year ? `, ${year}` : ""}`;
  return `${counts} &middot; ${span}`;
}

/** Renders the full ops page HTML document. */
export function renderOpsPage(data: OpsPageData): string {
  const body = `
  <div>
    <h1 class="title">ops</h1>
    <p class="subhead">internal dashboard &mdash; vote engagement and pipeline health.
      public but unlinked from the nav.</p>
    <p class="ops-note">${coverageNote(data)}</p>
  </div>

  ${engagementSection(data)}

  ${pipelineSection(data)}`;

  return renderPage({
    title: "janitor-bot · ops",
    active: null,
    body,
    tail: `${TOOLTIP_HTML}\n${TOOLTIP_SCRIPT}`,
  });
}
