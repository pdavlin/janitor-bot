/**
 * Tests for slack-events: signature verification, event-id dedupe, and the
 * reaction dispatcher.
 *
 * The dispatcher path stubs global fetch to simulate a successful users.info
 * response so the test exercises the full flow (lookup -> user check -> insert)
 * against an in-memory SQLite DB without any real network calls.
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../storage/db";
import type { DetectedPlay } from "../../types/play";
import { recordPlayMessage } from "../slack-messages-store";
import { recordFindingMessage } from "../slack-finding-messages-store";
import {
  verifySlackSignature,
  isDuplicateEvent,
  clearEventLru,
  dispatchEvent,
  type SlackEventEnvelope,
} from "../slack-events";
import { clearUserCache } from "../slack-user-cache";
import type { Logger } from "../../logger";
import type { RematchPlayDeps } from "../play-rematch-handler";

const SIGNING_SECRET = "test-signing-secret";

function silentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

/** Build a valid v0 signature for `(timestamp, body)` using the given secret. */
function sign(secret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// verifySlackSignature
// ---------------------------------------------------------------------------

describe("verifySlackSignature", () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "abc" });

  test("accepts a fresh, well-formed signature", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(SIGNING_SECRET, ts, body);
    expect(verifySlackSignature(SIGNING_SECRET, ts, sig, body)).toBe(true);
  });

  test("rejects when the signing secret differs", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign("other-secret", ts, body);
    expect(verifySlackSignature(SIGNING_SECRET, ts, sig, body)).toBe(false);
  });

  test("rejects when the body has been tampered with", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(SIGNING_SECRET, ts, body);
    const tampered = body.replace("abc", "xyz");
    expect(verifySlackSignature(SIGNING_SECRET, ts, sig, tampered)).toBe(false);
  });

  test("rejects timestamps drifting more than five minutes", () => {
    const sixMinutesAgo = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const sig = sign(SIGNING_SECRET, sixMinutesAgo, body);
    expect(verifySlackSignature(SIGNING_SECRET, sixMinutesAgo, sig, body)).toBe(
      false,
    );
  });

  test("rejects future timestamps drifting more than five minutes", () => {
    const sixMinutesAhead = String(Math.floor(Date.now() / 1000) + 6 * 60);
    const sig = sign(SIGNING_SECRET, sixMinutesAhead, body);
    expect(
      verifySlackSignature(SIGNING_SECRET, sixMinutesAhead, sig, body),
    ).toBe(false);
  });

  test("rejects when timestamp header is missing", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(SIGNING_SECRET, ts, body);
    expect(verifySlackSignature(SIGNING_SECRET, null, sig, body)).toBe(false);
  });

  test("rejects when signature header is missing", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifySlackSignature(SIGNING_SECRET, ts, null, body)).toBe(false);
  });

  test("rejects when timestamp is not numeric", () => {
    const sig = sign(SIGNING_SECRET, "0", body);
    expect(
      verifySlackSignature(SIGNING_SECRET, "not-a-number", sig, body),
    ).toBe(false);
  });

  test("rejects when signature length differs (avoids timingSafeEqual throw)", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifySlackSignature(SIGNING_SECRET, ts, "v0=tooshort", body)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// isDuplicateEvent
// ---------------------------------------------------------------------------

describe("isDuplicateEvent", () => {
  beforeEach(() => clearEventLru());

  test("returns false for a fresh event_id, true on the second sighting", () => {
    expect(isDuplicateEvent("Ev001")).toBe(false);
    expect(isDuplicateEvent("Ev001")).toBe(true);
  });

  test("distinct event_ids are independent", () => {
    expect(isDuplicateEvent("Ev001")).toBe(false);
    expect(isDuplicateEvent("Ev002")).toBe(false);
    expect(isDuplicateEvent("Ev001")).toBe(true);
    expect(isDuplicateEvent("Ev002")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispatchEvent
// ---------------------------------------------------------------------------

function makeAnglePlay(): DetectedPlay {
  return {
    gamePk: 7000,
    playIndex: 3,
    date: "2026-05-24",
    fielderId: 660271,
    fielderName: "Test Fielder",
    fielderPosition: "RF",
    runnerId: 100,
    runnerName: "Test Runner",
    targetBase: "3B",
    batterName: "Test Batter",
    inning: 5,
    halfInning: "top",
    awayScore: 2,
    homeScore: 3,
    awayTeam: "CHC",
    homeTeam: "PHI",
    description: "flies out to right fielder.",
    creditChain: "RF -> 3B",
    tier: "high",
    outs: 1,
    runnersOn: "1st",
    isOverturned: false,
    playId: "play-uuid-1",
    fetchStatus: "success",
    videoUrl: null,
    videoTitle: null,
    throwVelocity: null,
    throwVelocityStatus: null,
  };
}

describe("dispatchEvent", () => {
  let db: Database;
  let originalFetch: typeof fetch;
  let usersInfoResponse: { is_bot: boolean; is_restricted: boolean; is_ultra_restricted: boolean };

  beforeEach(() => {
    db = createDatabase(":memory:");
    clearUserCache();

    // Default: real user, eligible to vote.
    usersInfoResponse = {
      is_bot: false,
      is_restricted: false,
      is_ultra_restricted: false,
    };

    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/users.info")) {
        return new Response(
          JSON.stringify({ ok: true, user: usersInfoResponse }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  function makeEnvelope(
    overrides: {
      user?: string;
      reaction?: string;
      channel?: string;
      ts?: string;
      type?: "reaction_added" | "reaction_removed";
    } = {},
  ): SlackEventEnvelope {
    return {
      type: "event_callback",
      event_id: "Ev001",
      event: {
        type: overrides.type ?? "reaction_added",
        user: overrides.user ?? "U123",
        reaction: overrides.reaction ?? "fire",
        item: {
          type: "message",
          channel: overrides.channel ?? "C1",
          ts: overrides.ts ?? "100.001",
        },
        event_ts: "100.002",
      },
    };
  }

  function ctx() {
    return {
      db,
      logger: silentLogger(),
      slackConfig: { botToken: "xoxb-test" },
    };
  }

  function voteCount(): number {
    return (
      db.prepare("SELECT COUNT(*) as c FROM votes").get() as { c: number }
    ).c;
  }

  test("inserts a vote row when the message ts maps to a known play", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");

    await dispatchEvent(makeEnvelope(), ctx());

    const rows = db.prepare("SELECT * FROM votes").all() as Array<{
      user_id: string;
      game_pk: number;
      play_index: number;
      direction: string;
      action: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "U123",
      game_pk: 7000,
      play_index: 3,
      direction: "fire",
      action: "added",
    });
  });

  test("ignores reactions that don't map to a vote direction", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");

    await dispatchEvent(makeEnvelope({ reaction: "thumbsup" }), ctx());

    expect(voteCount()).toBe(0);
  });

  test(":movie_camera: routes to the angle handler and records no vote", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");
    insertPlay(db, makeAnglePlay());

    let angleCalled = 0;
    const angleCtx = {
      ...ctx(),
      angle: { enabled: true },
      angleDeps: {
        resolveAngle: async () => {
          angleCalled++;
          return { status: "no_alternate" as const };
        },
      },
    };

    await dispatchEvent(makeEnvelope({ reaction: "movie_camera" }), angleCtx);

    expect(angleCalled).toBe(1); // routed to the angle flow
    expect(voteCount()).toBe(0); // …and is not a vote
  });

  test(":fire: still votes and does NOT trigger the angle flow", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");
    insertPlay(db, makeAnglePlay());

    let angleCalled = 0;
    const angleCtx = {
      ...ctx(),
      angle: { enabled: true },
      angleDeps: {
        resolveAngle: async () => {
          angleCalled++;
          return { status: "no_alternate" as const };
        },
      },
    };

    await dispatchEvent(makeEnvelope({ reaction: "fire" }), angleCtx);

    expect(angleCalled).toBe(0); // fire is no longer the angle trigger
    expect(voteCount()).toBe(1); // fire still records a vote
  });

  test("ignores reactions on unknown ts", async () => {
    await dispatchEvent(makeEnvelope({ ts: "999.999" }), ctx());

    expect(voteCount()).toBe(0);
  });

  test("ignores reactions from bots", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");
    usersInfoResponse = {
      is_bot: true,
      is_restricted: false,
      is_ultra_restricted: false,
    };

    await dispatchEvent(makeEnvelope(), ctx());

    expect(voteCount()).toBe(0);
  });

  test("ignores reactions from guests", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");
    usersInfoResponse = {
      is_bot: false,
      is_restricted: true,
      is_ultra_restricted: false,
    };

    await dispatchEvent(makeEnvelope(), ctx());

    expect(voteCount()).toBe(0);
  });

  test("flags post_window=1 when the play was posted more than 24h ago", async () => {
    db.prepare(`
      INSERT INTO slack_play_messages (game_pk, play_index, channel, ts, parent_ts, posted_at, last_updated_at)
      VALUES (7000, 3, 'C1', '100.001', '99.000', datetime('now', '-25 hours'), NULL);
    `).run();

    await dispatchEvent(makeEnvelope(), ctx());

    const row = db.prepare("SELECT post_window FROM votes").get() as {
      post_window: number;
    };
    expect(row.post_window).toBe(1);
  });

  test("dispatches reaction_removed actions", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");

    await dispatchEvent(
      makeEnvelope({ type: "reaction_removed", reaction: "wastebasket" }),
      ctx(),
    );

    const row = db.prepare("SELECT direction, action FROM votes").get() as {
      direction: string;
      action: string;
    };
    expect(row).toEqual({ direction: "trash", action: "removed" });
  });

  test("ignores envelopes that aren't event_callback", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");
    await dispatchEvent({ type: "url_verification", challenge: "x" }, ctx());

    expect(voteCount()).toBe(0);
  });

  function resolutionCount(): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM finding_resolution_events;")
        .get() as { c: number }
    ).c;
  }

  test("white_check_mark on a known finding ts inserts confirm row", async () => {
    db.prepare(
      `INSERT INTO agent_runs (week_starting, model, started_at, status)
       VALUES ('2026-04-26', 'claude-sonnet-4-6', datetime('now'), 'started');`,
    ).run();
    const runId = (db.prepare(`SELECT id FROM agent_runs ORDER BY id DESC LIMIT 1;`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO agent_findings
         (run_id, finding_type, description, severity, evidence_strength,
          evidence_play_ids, suspected_rule_area)
        VALUES ($r, 'tx', 'd', 'watch', 'moderate', '[1]', 'area');`,
    ).run({ $r: runId });
    const findingId = (db.prepare(`SELECT id FROM agent_findings ORDER BY id DESC LIMIT 1;`).get() as { id: number }).id;
    recordFindingMessage(db, runId, findingId, "C1", "100.001", "99.000");

    await dispatchEvent(
      makeEnvelope({ reaction: "white_check_mark" }),
      ctx(),
    );

    const row = db
      .prepare("SELECT * FROM finding_resolution_events;")
      .get() as {
      finding_id: number;
      user_id: string;
      direction: string;
      action: string;
    };
    expect(row).toMatchObject({
      finding_id: findingId,
      user_id: "U123",
      direction: "confirm",
      action: "added",
    });
    expect(voteCount()).toBe(0);
  });

  test("x reaction on a known finding ts inserts reject row", async () => {
    db.prepare(
      `INSERT INTO agent_runs (week_starting, model, started_at, status)
       VALUES ('2026-04-26', 'claude-sonnet-4-6', datetime('now'), 'started');`,
    ).run();
    const runId = (db.prepare(`SELECT id FROM agent_runs ORDER BY id DESC LIMIT 1;`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO agent_findings
         (run_id, finding_type, description, severity, evidence_strength,
          evidence_play_ids, suspected_rule_area)
        VALUES ($r, 'tx', 'd', 'watch', 'moderate', '[1]', 'area');`,
    ).run({ $r: runId });
    const findingId = (db.prepare(`SELECT id FROM agent_findings ORDER BY id DESC LIMIT 1;`).get() as { id: number }).id;
    recordFindingMessage(db, runId, findingId, "C1", "100.001", "99.000");

    await dispatchEvent(makeEnvelope({ reaction: "x" }), ctx());

    const row = db
      .prepare("SELECT direction, action FROM finding_resolution_events;")
      .get() as { direction: string; action: string };
    expect(row).toEqual({ direction: "reject", action: "added" });
  });

  test("ineligible reactor (bot) does not write a resolution row", async () => {
    db.prepare(
      `INSERT INTO agent_runs (week_starting, model, started_at, status)
       VALUES ('2026-04-26', 'claude-sonnet-4-6', datetime('now'), 'started');`,
    ).run();
    const runId = (db.prepare(`SELECT id FROM agent_runs ORDER BY id DESC LIMIT 1;`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO agent_findings
         (run_id, finding_type, description, severity, evidence_strength,
          evidence_play_ids, suspected_rule_area)
        VALUES ($r, 'tx', 'd', 'watch', 'moderate', '[1]', 'area');`,
    ).run({ $r: runId });
    const findingId = (db.prepare(`SELECT id FROM agent_findings ORDER BY id DESC LIMIT 1;`).get() as { id: number }).id;
    recordFindingMessage(db, runId, findingId, "C1", "100.001", "99.000");

    usersInfoResponse = {
      is_bot: true,
      is_restricted: false,
      is_ultra_restricted: false,
    };

    await dispatchEvent(
      makeEnvelope({ reaction: "white_check_mark" }),
      ctx(),
    );

    expect(resolutionCount()).toBe(0);
  });

  test("white_check_mark on a non-finding ts is ignored", async () => {
    await dispatchEvent(
      makeEnvelope({ reaction: "white_check_mark", ts: "999.999" }),
      ctx(),
    );

    expect(resolutionCount()).toBe(0);
  });

  test(":repeat: reaction invokes the re-match orchestrator with play lookup", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");

    const rematchVideo = mock(async () => ({
      decision: "agreed" as const,
      reason: "ok",
    }));
    const fetchGameVideos = mock(async () => [
      {
        id: "vid-1",
        title: "T",
        description: "D",
        playbacks: [
          { name: "mp4Avc", url: "https://x/y.mp4", width: "1", height: "1" },
        ],
      },
    ]);

    // Insert a play row so the handler can read description / video_url.
    db.prepare(
      `INSERT INTO plays (game_pk, play_index, date, fielder_id, fielder_name,
         fielder_position, runner_id, runner_name, target_base, batter_name,
         inning, half_inning, away_score, home_score, away_team, home_team,
         description, credit_chain, tier, outs, runners_on, is_overturned)
       VALUES (7000, 3, '2026-05-27', 1, 'F', 'RF', 2, 'R', '3B', 'B',
         7, 'top', 1, 2, 'LAD', 'ATL', 'desc', 'RF->3B', 'high', 1, '1st', 0);`,
    ).run();

    const dispatchCtx = {
      db,
      logger: silentLogger(),
      slackConfig: { botToken: "xoxb-test" },
      rematch: {
        enabled: true,
        apiKey: "test-key",
        model: "claude-sonnet-4-6",
      },
      rematchDeps: {
        rematchVideo: rematchVideo as unknown as RematchPlayDeps["rematchVideo"],
        fetchGameVideos: fetchGameVideos as unknown as RematchPlayDeps["fetchGameVideos"],
      },
    };
    await dispatchEvent(makeEnvelope({ reaction: "repeat" }), dispatchCtx);

    expect(rematchVideo).toHaveBeenCalledTimes(1);
    const evtRow = db
      .prepare("SELECT decision, user_id FROM play_rematch_events;")
      .get() as { decision: string; user_id: string };
    expect(evtRow).toEqual({ decision: "agreed", user_id: "U123" });
  });

  test(":repeat: from a bot user is ignored (no agent call, no event row)", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");
    usersInfoResponse = {
      is_bot: true,
      is_restricted: false,
      is_ultra_restricted: false,
    };
    const rematchVideo = mock(async () => ({ decision: "agreed" as const }));
    const fetchGameVideos = mock(async () => []);

    const dispatchCtx = {
      db,
      logger: silentLogger(),
      slackConfig: { botToken: "xoxb-test" },
      rematch: {
        enabled: true,
        apiKey: "test-key",
        model: "claude-sonnet-4-6",
      },
      rematchDeps: {
        rematchVideo: rematchVideo as unknown as RematchPlayDeps["rematchVideo"],
        fetchGameVideos: fetchGameVideos as unknown as RematchPlayDeps["fetchGameVideos"],
      },
    };
    await dispatchEvent(makeEnvelope({ reaction: "repeat" }), dispatchCtx);

    expect(rematchVideo).not.toHaveBeenCalled();
    expect(fetchGameVideos).not.toHaveBeenCalled();
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM play_rematch_events;").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });

  test(":repeat: with rematch config absent is a no-op", async () => {
    recordPlayMessage(db, 7000, 3, "C1", "100.001", "99.000");
    await dispatchEvent(makeEnvelope({ reaction: "repeat" }), ctx());
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM play_rematch_events;").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });

  test("reaction_removed on a finding ts records action=removed", async () => {
    db.prepare(
      `INSERT INTO agent_runs (week_starting, model, started_at, status)
       VALUES ('2026-04-26', 'claude-sonnet-4-6', datetime('now'), 'started');`,
    ).run();
    const runId = (db.prepare(`SELECT id FROM agent_runs ORDER BY id DESC LIMIT 1;`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO agent_findings
         (run_id, finding_type, description, severity, evidence_strength,
          evidence_play_ids, suspected_rule_area)
        VALUES ($r, 'tx', 'd', 'watch', 'moderate', '[1]', 'area');`,
    ).run({ $r: runId });
    const findingId = (db.prepare(`SELECT id FROM agent_findings ORDER BY id DESC LIMIT 1;`).get() as { id: number }).id;
    recordFindingMessage(db, runId, findingId, "C1", "100.001", "99.000");

    await dispatchEvent(
      makeEnvelope({ type: "reaction_removed", reaction: "white_check_mark" }),
      ctx(),
    );

    const row = db
      .prepare("SELECT direction, action FROM finding_resolution_events;")
      .get() as { direction: string; action: string };
    expect(row).toEqual({ direction: "confirm", action: "removed" });
  });
});
