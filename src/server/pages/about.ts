/**
 * GET /about — static pipeline explainer: five fieldset stages (detect,
 * tier, post, vote, review) joined by ASCII connectors, each carrying one
 * real artifact baked in from the production data at design time.
 *
 * The tier-stage copy is a contract with src/detection/ranking.ts: target
 * base Home 4 / 3B 3 / 2B 1, direct +2, 3+-segment relay -2, video +1,
 * overturn -2, +1 for a 95+ mph throw, mapped 5+ high / 3-4 medium /
 * 0-2 low. Update both together.
 */

import { renderPage } from "./shell";
import { tierBadge } from "./components";

/** ASCII connector between pipeline stages. */
const WIRE = `<div class="wire" aria-hidden="true"><span>|</span><span>v</span></div>`;

/** Renders the full about page HTML document. */
export function renderAboutPage(): string {
  const body = `
  <h1 class="title">about</h1>

  <p class="lede">
    <b>janitor-bot</b> watches every MLB game for one thing: an outfielder
    who guns down a baserunner. It grades the throw, posts the clip, and lets
    the channel argue. A weekly agent then checks its own grading against how
    people actually reacted. Five stages, top to bottom.
  </p>

  <div class="pipeline flow">

    <fieldset class="stage">
      <legend>detect</legend>
      <p class="step">stage 1 of 5</p>
      <h2>watch the play-by-play</h2>
      <p>
        It polls the MLB Stats API for every game in progress. When a runner
        is retired and an outfielder started the throw, that play gets pulled
        out of the feed &mdash; nothing else counts as an outfield assist.
      </p>
      <p>
        The raw play <span class="chain">description</span> is what triggers
        everything downstream.
      </p>
      <div class="artifact">
        <span class="tag">real play &middot; from plays table</span>
        <div class="quote">
          &ldquo;Hao-Yu Lee singles on a sharp line drive to left fielder Cody
          Bellinger. Riley Greene out at home on the throw, left fielder Cody
          Bellinger to catcher Austin Wells.&rdquo;
        </div>
        <div class="note">parsed to &rarr; <span class="chain">LF &rarr; C</span>,
          target base <b>Home</b>, Cody Bellinger throws out Riley Greene.</div>
      </div>
    </fieldset>

    ${WIRE}

    <fieldset class="stage">
      <legend>tier</legend>
      <p class="step">stage 2 of 5</p>
      <h2>score the throw</h2>
      <p>
        Each play earns points and lands in one of three tiers. Target base
        pays the most (Home 4, 3B 3, 2B 1). A direct throw adds 2; a relay
        with 3+ fielders subtracts 2. Available video adds 1, and an out that
        only stood because of a replay overturn subtracts 2.
      </p>
      <p>
        A throw clocked at 95+ mph adds 1 more, on the rare play where
        Statcast velocity is on hand.
      </p>
      <p>
        Totals map to ${tierBadge("high")} (5+),
        ${tierBadge("medium")} (3&ndash;4), and
        ${tierBadge("low")} (0&ndash;2).
      </p>
      <div class="artifact">
        <span class="tag">real credit chain &middot; scores medium</span>
        <div class="quote">
          <span class="chain">RF &rarr; SS &rarr; C</span> &nbsp; target base
          <b>Home</b> &nbsp; video&nbsp;yes
        </div>
        <div class="calc">
          <span>target base: Home</span><span class="op">+4</span>
          <span>relay chain (3 segments)</span><span class="op">&minus;2</span>
          <span>video available</span><span class="op">+1</span>
          <span class="total">score 3 &rarr; ${tierBadge("medium")}</span><span class="op total">= 3</span>
        </div>
        <div class="note">A throw home would tier high on its own, but the cut
          through the shortstop is a relay &mdash; the &minus;2 penalty drops it
          to medium.</div>
      </div>
    </fieldset>

    ${WIRE}

    <fieldset class="stage">
      <legend>post</legend>
      <p class="step">stage 3 of 5</p>
      <h2>drop it in slack</h2>
      <p>
        The play goes to the channel with its Baseball Savant video. When
        Savant carries more than one camera, every angle is posted &mdash;
        home, away, and high-home &mdash; not just the first one it finds.
      </p>
      <div class="slack">
        <div><span class="bot">janitor-bot</span> <span class="meta">APP &middot; 7:14 PM</span></div>
        <div>&#x1F525; <b>CF &rarr; C</b> &middot; Home &middot; ${tierBadge("high")}</div>
        <div>Ceddanne Rafaela guns down Edouard Julien at the plate (MIN @ BOS, top 7)</div>
        <div class="angles">&#x25B6; <a href="#">home</a> &nbsp; &#x25B6; <a href="#">away</a> &nbsp; &#x25B6; <a href="#">high-home</a></div>
        <div class="react">react &#x1F525; if it rips &middot; &#x1F5D1; if it&rsquo;s a nothing play</div>
      </div>
    </fieldset>

    ${WIRE}

    <fieldset class="stage">
      <legend>vote</legend>
      <p class="step">stage 4 of 5</p>
      <h2>let the channel judge</h2>
      <p>
        Teammates react &#x1F525; for a real gem and &#x1F5D1; for a dud. Votes
        are snapshotted per play into a fire count, trash count, and net score.
      </p>
      <p>
        When the crowd and the tier disagree &mdash; a low play people love, a
        high play they ignore &mdash; the play is flagged for the weekly review
        to look at.
      </p>
      <div class="artifact">
        <span class="tag">real tally &middot; from vote_snapshots</span>
        <div class="quote"><span class="chain">LF &rarr; C</span> &middot; Elly De La Cruz
          throws out Matt McLain at home</div>
        <div class="tally">
          <span>&#x1F525; fire <b>3</b></span>
          <span>&#x1F5D1; trash <b>0</b></span>
          <span>net <b>+3</b></span>
        </div>
        <div class="note">Not every play lands this cleanly. A separate throw
          home this season pulled <b>0&#x1F525; / 2&#x1F5D1;</b> (net &minus;2)
          against a medium tier &mdash; flagged
          <span class="chain">channel_disagrees_high_or_medium</span> for review.</div>
      </div>
    </fieldset>

    ${WIRE}

    <fieldset class="stage">
      <legend>review</legend>
      <p class="step">stage 5 of 5</p>
      <h2>audit the week</h2>
      <p>
        Once a week an agent reads every detection against its votes and the
        prior weeks&rsquo; history. It files findings about where the scoring
        and the channel disagree, each tagged to a suspected rule area.
      </p>
      <p>
        A human marks each finding <b>confirmed</b> or <b>rejected</b>. The
        confirmed ones become the next change to the tiering rules &mdash; the
        relay penalty above came out of exactly this loop.
      </p>
      <div class="artifact">
        <span class="tag">real finding &middot; from agent_findings</span>
        <div class="finding-meta">
          <span class="pill">severity: info</span>
          <span class="pill">trend: recurring</span>
          <span class="pill confirmed">outcome: confirmed</span>
        </div>
        <div class="quote">
          &ldquo;Play 333 (LF&rarr;SS&rarr;C&rarr;3B, medium tier, CWS@PHI) is
          the only play this week to receive a trash vote (net score &minus;1).
          The credit chain involves four hops &mdash; the longest relay chain in
          the week&rsquo;s dataset &mdash; yet the play was classified medium
          rather than low.&rdquo;
        </div>
        <div class="note">rule area: <span class="chain">new_tunable_needed</span>
          &middot; directionally consistent with a prior confirmed finding on
          relay length &rarr; fed the relay penalty now in <span class="chain">ranking.ts</span>.</div>
      </div>
    </fieldset>

  </div>`;

  return renderPage({ title: "janitor-bot · about", active: "about", body });
}
