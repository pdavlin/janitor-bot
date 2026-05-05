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
import { createDatabase } from "../../storage/db";
import { recordPlayMessage } from "../slack-messages-store";
import {
  verifySlackSignature,
  isDuplicateEvent,
  clearEventLru,
  dispatchEvent,
  type SlackEventEnvelope,
} from "../slack-events";
import { clearUserCache } from "../slack-user-cache";
import type { Logger } from "../../logger";

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
});
