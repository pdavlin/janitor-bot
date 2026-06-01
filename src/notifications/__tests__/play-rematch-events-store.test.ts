/**
 * Tests for play-rematch-events-store: insert + latest-event lookup.
 * Uses an in-memory DB so the schema + CHECK constraints are real.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../storage/db";
import {
  getLatestRematchEvent,
  insertPlayRematchEvent,
  insertAngleEvent,
  hasAngleTriggerRun,
  type RematchDecision,
  type AngleDecision,
} from "../play-rematch-events-store";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("insertPlayRematchEvent", () => {
  test("writes a swapped row that reads back via raw SQL", () => {
    insertPlayRematchEvent(db, {
      gamePk: 7000,
      playIndex: 3,
      userId: "U1",
      priorVideoUrl: "https://old.example.com/a.mp4",
      newVideoUrl: "https://new.example.com/b.mp4",
      decision: "swapped",
      agentReason: "better keyword match",
      eventTs: "1700000000.000200",
    });
    const row = db.prepare("SELECT * FROM play_rematch_events;").get() as {
      game_pk: number;
      play_index: number;
      user_id: string;
      prior_video_url: string | null;
      new_video_url: string | null;
      decision: string;
      agent_reason: string | null;
      event_ts: string;
    };
    expect(row).toMatchObject({
      game_pk: 7000,
      play_index: 3,
      user_id: "U1",
      prior_video_url: "https://old.example.com/a.mp4",
      new_video_url: "https://new.example.com/b.mp4",
      decision: "swapped",
      agent_reason: "better keyword match",
      event_ts: "1700000000.000200",
    });
  });

  test.each<RematchDecision>(["swapped", "agreed", "no_match", "deduped"])(
    "accepts decision=%s",
    (decision) => {
      insertPlayRematchEvent(db, {
        gamePk: 1,
        playIndex: 1,
        userId: "U1",
        priorVideoUrl: null,
        newVideoUrl: null,
        decision,
        agentReason: null,
        eventTs: "1",
      });
      const row = db
        .prepare("SELECT decision FROM play_rematch_events;")
        .get() as { decision: string };
      expect(row.decision).toBe(decision);
    },
  );

  test("nullable prior/new urls persist as null", () => {
    insertPlayRematchEvent(db, {
      gamePk: 1,
      playIndex: 2,
      userId: "U1",
      priorVideoUrl: null,
      newVideoUrl: null,
      decision: "no_match",
      agentReason: null,
      eventTs: "1",
    });
    const row = db
      .prepare(
        "SELECT prior_video_url, new_video_url, agent_reason FROM play_rematch_events;",
      )
      .get() as {
      prior_video_url: string | null;
      new_video_url: string | null;
      agent_reason: string | null;
    };
    expect(row.prior_video_url).toBeNull();
    expect(row.new_video_url).toBeNull();
    expect(row.agent_reason).toBeNull();
  });

  test("rejects invalid decision via CHECK constraint", () => {
    expect(() =>
      insertPlayRematchEvent(db, {
        gamePk: 1,
        playIndex: 1,
        userId: "U1",
        priorVideoUrl: null,
        newVideoUrl: null,
        // @ts-expect-error - intentionally invalid for test
        decision: "bogus",
        agentReason: null,
        eventTs: "1",
      }),
    ).toThrow();
  });
});

describe("getLatestRematchEvent", () => {
  test("returns null when no events exist", () => {
    expect(getLatestRematchEvent(db, 7000, 3)).toBeNull();
  });

  test("returns the highest-id row for (game_pk, play_index)", () => {
    insertPlayRematchEvent(db, {
      gamePk: 7000,
      playIndex: 3,
      userId: "U1",
      priorVideoUrl: "url-A",
      newVideoUrl: "url-B",
      decision: "swapped",
      agentReason: "first",
      eventTs: "1",
    });
    insertPlayRematchEvent(db, {
      gamePk: 7000,
      playIndex: 3,
      userId: "U2",
      priorVideoUrl: "url-B",
      newVideoUrl: null,
      decision: "agreed",
      agentReason: "second",
      eventTs: "2",
    });
    const latest = getLatestRematchEvent(db, 7000, 3);
    expect(latest).toMatchObject({
      userId: "U2",
      priorVideoUrl: "url-B",
      decision: "agreed",
      agentReason: "second",
    });
  });

  test("isolates rows by (game_pk, play_index)", () => {
    insertPlayRematchEvent(db, {
      gamePk: 7000,
      playIndex: 3,
      userId: "U1",
      priorVideoUrl: "url-A",
      newVideoUrl: null,
      decision: "no_match",
      agentReason: null,
      eventTs: "1",
    });
    insertPlayRematchEvent(db, {
      gamePk: 7001,
      playIndex: 3,
      userId: "U1",
      priorVideoUrl: "url-X",
      newVideoUrl: null,
      decision: "no_match",
      agentReason: null,
      eventTs: "2",
    });

    expect(getLatestRematchEvent(db, 7000, 3)?.priorVideoUrl).toBe("url-A");
    expect(getLatestRematchEvent(db, 7001, 3)?.priorVideoUrl).toBe("url-X");
  });

  test("preserves null prior/new urls when reading back", () => {
    insertPlayRematchEvent(db, {
      gamePk: 7000,
      playIndex: 3,
      userId: "U1",
      priorVideoUrl: null,
      newVideoUrl: null,
      decision: "deduped",
      agentReason: null,
      eventTs: "1",
    });
    const latest = getLatestRematchEvent(db, 7000, 3);
    expect(latest?.priorVideoUrl).toBeNull();
    expect(latest?.newVideoUrl).toBeNull();
  });
});

describe("insertAngleEvent", () => {
  test.each<AngleDecision>(["angle_found", "angle_no_alternate", "angle_error", "angle_deduped"])(
    "accepts angle decision=%s",
    (decision) => {
      insertAngleEvent(db, {
        gamePk: 1,
        playIndex: 1,
        userId: "U1",
        decision,
        agentReason: null,
        eventTs: "1",
      });
      const row = db
        .prepare("SELECT decision FROM play_rematch_events;")
        .get() as { decision: string };
      expect(row.decision).toBe(decision);
    },
  );

  test("angle event persists with null prior/new video urls", () => {
    insertAngleEvent(db, {
      gamePk: 7000,
      playIndex: 5,
      userId: "U2",
      decision: "angle_found",
      agentReason: "cf angle uploaded",
      eventTs: "1700000000.000300",
    });
    const row = db.prepare("SELECT * FROM play_rematch_events;").get() as {
      game_pk: number;
      play_index: number;
      user_id: string;
      prior_video_url: string | null;
      new_video_url: string | null;
      decision: string;
      agent_reason: string | null;
    };
    expect(row).toMatchObject({
      game_pk: 7000,
      play_index: 5,
      user_id: "U2",
      prior_video_url: null,
      new_video_url: null,
      decision: "angle_found",
      agent_reason: "cf angle uploaded",
    });
  });
});

describe("hasAngleTriggerRun", () => {
  test("returns false when no events exist", () => {
    expect(hasAngleTriggerRun(db, 7000, 3)).toBe(false);
  });

  test("returns false when only rematch events exist", () => {
    insertPlayRematchEvent(db, {
      gamePk: 7000,
      playIndex: 3,
      userId: "U1",
      priorVideoUrl: "url-A",
      newVideoUrl: "url-B",
      decision: "swapped",
      agentReason: null,
      eventTs: "1",
    });
    expect(hasAngleTriggerRun(db, 7000, 3)).toBe(false);
  });

  test("returns true when a angle_found event exists", () => {
    insertAngleEvent(db, {
      gamePk: 7000,
      playIndex: 3,
      userId: "U1",
      decision: "angle_found",
      agentReason: null,
      eventTs: "1",
    });
    expect(hasAngleTriggerRun(db, 7000, 3)).toBe(true);
  });

  test("returns true when a angle_no_alternate event exists", () => {
    insertAngleEvent(db, {
      gamePk: 7000,
      playIndex: 3,
      userId: "U1",
      decision: "angle_no_alternate",
      agentReason: null,
      eventTs: "1",
    });
    expect(hasAngleTriggerRun(db, 7000, 3)).toBe(true);
  });

  test("returns true when a angle_deduped event exists", () => {
    insertAngleEvent(db, {
      gamePk: 7000,
      playIndex: 3,
      userId: "U1",
      decision: "angle_deduped",
      agentReason: null,
      eventTs: "1",
    });
    expect(hasAngleTriggerRun(db, 7000, 3)).toBe(true);
  });

  test("isolates by (game_pk, play_index)", () => {
    insertAngleEvent(db, {
      gamePk: 7000,
      playIndex: 3,
      userId: "U1",
      decision: "angle_found",
      agentReason: null,
      eventTs: "1",
    });
    expect(hasAngleTriggerRun(db, 7000, 3)).toBe(true);
    expect(hasAngleTriggerRun(db, 7000, 4)).toBe(false);
    expect(hasAngleTriggerRun(db, 7001, 3)).toBe(false);
  });
});
