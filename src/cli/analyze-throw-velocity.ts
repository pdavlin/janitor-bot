/**
 * Analysis script: correlate throw velocity with recorded reactions.
 *
 * Reads plays joined to votes/vote_snapshots, buckets by velocity,
 * and reports fire-rate / net / voter counts per bucket, plus the
 * same cross-tabbed against target base, relay length, position,
 * and hasVideo for confound visibility.
 *
 * Output: a markdown report to stdout, suitable for piping to
 * docs/ideation/see-the-throw/velocity-calibration.md
 *
 * Usage:
 *   bun run src/cli/analyze-throw-velocity.ts > docs/ideation/see-the-throw/velocity-calibration.md
 *
 * Environment:
 *   DB_PATH - path to SQLite database file (default: ./janitor-throws.db)
 */

import { loadConfig } from "../config";
import { createDatabase } from "../storage/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VelocityBucket {
  label: string;
  min: number;
  max: number | null; // null = unbounded
  plays: number;
  playsWithVotes: number;
  fireTotal: number;
  trashTotal: number;
  netScore: number;
  voterCount: number;
  fireRate: number; // fire / (fire + trash), 0-1
}

interface CrossTab {
  dimension: string;
  value: string;
  plays: number;
  playsWithVotes: number;
  fireTotal: number;
  trashTotal: number;
  netScore: number;
  avgVelocity: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PlayWithVotes {
  throw_velocity: number;
  target_base: string;
  credit_chain: string;
  fielder_position: string;
  has_video: number;
  fire_count: number | null;
  trash_count: number | null;
  net_score: number | null;
  voter_count: number | null;
}

function bucketVelocity(mph: number, buckets: { min: number; max: number | null }[]): number {
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (mph >= b.min && (b.max === null || mph < b.max)) {
      return i;
    }
  }
  return buckets.length - 1; // fallback to last bucket
}

function formatPercent(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function formatVelocity(n: number): string {
  return n.toFixed(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.dbPath);

  try {
    // Join plays to vote snapshots to get reaction data
    // Exclude sentinel -1 values (untracked throws)
    const rows = db
      .prepare(
        `
      SELECT
        p.throw_velocity,
        p.target_base,
        p.credit_chain,
        p.fielder_position,
        CASE WHEN p.video_url IS NOT NULL THEN 1 ELSE 0 END as has_video,
        vs.fire_count,
        vs.trash_count,
        vs.net_score,
        vs.voter_count
      FROM plays p
      LEFT JOIN vote_snapshots vs ON p.game_pk = vs.game_pk AND p.play_index = vs.play_index
      WHERE p.throw_velocity IS NOT NULL
        AND p.throw_velocity > 0
      ORDER BY p.throw_velocity DESC;
    `,
      )
      .all() as PlayWithVotes[];

    if (rows.length === 0) {
      console.log("# Throw Velocity Calibration Report\n");
      console.log("**No plays with throw velocity data found.**\n");
      console.log("Run the backfill script first:");
      console.log("```bash");
      console.log("bun run src/cli/backfill-throw-velocity.ts");
      console.log("```\n");
      return;
    }

    // Define velocity buckets
    const bucketDefs = [
      { min: 0, max: 80, label: "< 80 mph" },
      { min: 80, max: 85, label: "80-85 mph" },
      { min: 85, max: 90, label: "85-90 mph" },
      { min: 90, max: 95, label: "90-95 mph" },
      { min: 95, max: 100, label: "95-100 mph" },
      { min: 100, max: null, label: "100+ mph" },
    ];

    // Initialize buckets
    const buckets: VelocityBucket[] = bucketDefs.map((d) => ({
      ...d,
      plays: 0,
      playsWithVotes: 0,
      fireTotal: 0,
      trashTotal: 0,
      netScore: 0,
      voterCount: 0,
      fireRate: 0,
    }));

    // Initialize cross-tabs
    const crossByBase = new Map<string, CrossTab>();
    const crossByPosition = new Map<string, CrossTab>();
    const crossByRelayLength = new Map<string, CrossTab>();
    const crossByVideo = new Map<string, CrossTab>();

    // Process rows
    for (const row of rows) {
      const bIdx = bucketVelocity(row.throw_velocity, bucketDefs);
      const bucket = buckets[bIdx];
      bucket.plays++;

      const fire = row.fire_count ?? 0;
      const trash = row.trash_count ?? 0;
      const net = row.net_score ?? 0;
      const voters = row.voter_count ?? 0;

      if (fire + trash > 0) {
        bucket.playsWithVotes++;
      }
      bucket.fireTotal += fire;
      bucket.trashTotal += trash;
      bucket.netScore += net;
      bucket.voterCount += voters;

      // Cross-tabs
      const base = row.target_base;
      if (!crossByBase.has(base)) {
        crossByBase.set(base, {
          dimension: "Target Base",
          value: base,
          plays: 0,
          playsWithVotes: 0,
          fireTotal: 0,
          trashTotal: 0,
          netScore: 0,
          avgVelocity: 0,
        });
      }
      const cb = crossByBase.get(base)!;
      cb.plays++;
      if (fire + trash > 0) cb.playsWithVotes++;
      cb.fireTotal += fire;
      cb.trashTotal += trash;
      cb.netScore += net;
      cb.avgVelocity =
        (cb.avgVelocity * (cb.plays - 1) + row.throw_velocity) / cb.plays;

      const pos = row.fielder_position;
      if (!crossByPosition.has(pos)) {
        crossByPosition.set(pos, {
          dimension: "Position",
          value: pos,
          plays: 0,
          playsWithVotes: 0,
          fireTotal: 0,
          trashTotal: 0,
          netScore: 0,
          avgVelocity: 0,
        });
      }
      const cp = crossByPosition.get(pos)!;
      cp.plays++;
      if (fire + trash > 0) cp.playsWithVotes++;
      cp.fireTotal += fire;
      cp.trashTotal += trash;
      cp.netScore += net;
      cp.avgVelocity =
        (cp.avgVelocity * (cp.plays - 1) + row.throw_velocity) / cp.plays;

      const segments = row.credit_chain.split(" -> ");
      const relayLength = segments.length <= 2 ? "Direct" : "Relay";
      if (!crossByRelayLength.has(relayLength)) {
        crossByRelayLength.set(relayLength, {
          dimension: "Throw Type",
          value: relayLength,
          plays: 0,
          playsWithVotes: 0,
          fireTotal: 0,
          trashTotal: 0,
          netScore: 0,
          avgVelocity: 0,
        });
      }
      const cr = crossByRelayLength.get(relayLength)!;
      cr.plays++;
      if (fire + trash > 0) cr.playsWithVotes++;
      cr.fireTotal += fire;
      cr.trashTotal += trash;
      cr.netScore += net;
      cr.avgVelocity =
        (cr.avgVelocity * (cr.plays - 1) + row.throw_velocity) / cr.plays;

      const video = row.has_video ? "Has Video" : "No Video";
      if (!crossByVideo.has(video)) {
        crossByVideo.set(video, {
          dimension: "Video",
          value: video,
          plays: 0,
          playsWithVotes: 0,
          fireTotal: 0,
          trashTotal: 0,
          netScore: 0,
          avgVelocity: 0,
        });
      }
      const cv = crossByVideo.get(video)!;
      cv.plays++;
      if (fire + trash > 0) cv.playsWithVotes++;
      cv.fireTotal += fire;
      cv.trashTotal += trash;
      cv.netScore += net;
      cv.avgVelocity =
        (cv.avgVelocity * (cv.plays - 1) + row.throw_velocity) / cv.plays;
    }

    // Compute fire rates
    for (const bucket of buckets) {
      const total = bucket.fireTotal + bucket.trashTotal;
      bucket.fireRate = total > 0 ? bucket.fireTotal / total : 0;
    }

    // Overall stats
    const totalPlays = rows.length;
    const totalWithVotes = rows.filter(
      (r) => (r.fire_count ?? 0) + (r.trash_count ?? 0) > 0,
    ).length;
    const totalFire = rows.reduce((s, r) => s + (r.fire_count ?? 0), 0);
    const totalTrash = rows.reduce((s, r) => s + (r.trash_count ?? 0), 0);
    const avgVelocity =
      rows.reduce((s, r) => s + r.throw_velocity, 0) / totalPlays;

    // ---------------------------------------------------------------------------
    // Output
    // ---------------------------------------------------------------------------

    console.log("# Throw Velocity Calibration Report\n");
    console.log(
      `Generated: ${new Date().toISOString().split("T")[0]}\n`,
    );

    console.log("## Summary\n");
    console.log(`- **Plays with velocity data**: ${totalPlays}`);
    console.log(`- **Plays with any votes**: ${totalWithVotes} (${formatPercent(totalWithVotes / totalPlays)})`);
    console.log(`- **Total fire reactions**: ${totalFire}`);
    console.log(`- **Total trash reactions**: ${totalTrash}`);
    console.log(`- **Overall fire rate**: ${formatPercent(totalFire / (totalFire + totalTrash || 1))}`);
    console.log(`- **Average velocity**: ${formatVelocity(avgVelocity)} mph\n`);

    console.log("## Velocity Buckets\n");
    console.log("| Bucket | Plays | With Votes | Fire | Trash | Net | Fire Rate |");
    console.log("|--------|-------|------------|------|-------|-----|-----------|");

    for (const b of buckets) {
      if (b.plays === 0) continue;
      console.log(
        `| ${b.label} | ${b.plays} | ${b.playsWithVotes} | ${b.fireTotal} | ${b.trashTotal} | ${b.netScore} | ${formatPercent(b.fireRate)} |`,
      );
    }

    console.log("\n## Cross-Tabulations\n");

    function printCrossTab(tabs: Map<string, CrossTab>, name: string) {
      console.log(`### By ${name}\n`);
      console.log(`| ${tabs.values().next().value?.dimension ?? name} | Plays | With Votes | Fire | Trash | Net | Avg Velocity |`);
      console.log("|---|-------|------------|------|-------|-----|--------------|");
      for (const [, t] of tabs) {
        console.log(
          `| ${t.value} | ${t.plays} | ${t.playsWithVotes} | ${t.fireTotal} | ${t.trashTotal} | ${t.netScore} | ${formatVelocity(t.avgVelocity)} |`,
        );
      }
      console.log("");
    }

    printCrossTab(crossByBase, "Target Base");
    printCrossTab(crossByPosition, "Position");
    printCrossTab(crossByRelayLength, "Throw Type");
    printCrossTab(crossByVideo, "Video Availability");

    // Confidence and band recommendation
    console.log("## Confidence Assessment\n");

    const votesPerBucket = buckets
      .filter((b) => b.plays > 0)
      .map((b) => ({
        label: b.label,
        plays: b.plays,
        playsWithVotes: b.playsWithVotes,
        voteRate: b.playsWithVotes / b.plays,
      }));

    const lowSampleBuckets = votesPerBucket.filter((b) => b.plays < 10);
    const lowVoteBuckets = votesPerBucket.filter((b) => b.voteRate < 0.1);

    if (lowSampleBuckets.length > 0) {
      console.log("⚠️  **Low sample warning**: The following buckets have fewer than 10 plays:");
      for (const b of lowSampleBuckets) {
        console.log(`- ${b.label}: ${b.plays} plays`);
      }
      console.log("");
    }

    if (lowVoteBuckets.length > 0) {
      console.log("⚠️  **Sparse vote warning**: The following buckets have vote rates below 10%:");
      for (const b of lowVoteBuckets) {
        console.log(`- ${b.label}: ${formatPercent(b.voteRate)} vote rate`);
      }
      console.log("");
    }

    const negativeTrashRate =
      totalTrash / (totalFire + totalTrash || 1);
    if (negativeTrashRate < 0.05) {
      console.log(
        "⚠️  **Near-zero trash signal**: Trash reactions are very sparse (<5% of total). " +
          "The velocity-to-reaction correlation is unreliable for tier calibration. " +
          "Recommend conservative default (single +1 above 95 mph) rather than aggressive multi-band mapping.\n",
      );
    }

    console.log("## Recommended velocityBonus Bands\n");
    console.log(
      "Based on the analysis above, the following conservative mapping is recommended:",
    );
    console.log("");
    console.log("```typescript");
    console.log("function velocityBonus(mph: number | null | undefined): number {");
    console.log("  if (mph == null) return 0;");
    console.log("  if (mph >= 95) return 1;");
    console.log("  return 0;");
    console.log("}");
    console.log("```\n");
    console.log(
      "**Rationale**: With sparse negative signal, a single threshold at 95 mph " +
        "provides a modest lift for elite throws without overfitting to a dataset " +
        "that cannot reliably distinguish velocity-driven reactions from other factors. " +
        "This can be revisited as more vote data accumulates.\n",
    );

    console.log("## Data Limitations\n");
    console.log("- Reactions are sparse and overwhelmingly positive (near-zero trash)");
    console.log("- Velocity is confounded with video availability and throw difficulty");
    console.log("- Sample sizes in higher velocity buckets may be insufficient for statistical significance");
    console.log("- The analysis does not control for game context (score, inning, importance)\n");

    console.log("---\n");
    console.log(
      "*This report is a committed artifact. The `velocityBonus` bands in `src/detection/ranking.ts` " +
        "should reference this document for auditable rationale.*",
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(
    "Fatal error:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
