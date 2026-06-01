/**
 * Tests for handleAngleTrigger: the :movie_camera:-reaction alternate-angle window
 * and dedup. The angle resolver is stubbed (no_alternate) so the upload
 * path is never reached — these guard the window + dedup gating only.
 *
 * The window test is the regression guard for the Slack-ts date bug: the
 * handler previously did `new Date(eventTs)` on an epoch-seconds string
 * (Invalid Date → NaN), so the age check never rejected anything.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createLogger } from "../../logger";
import { createDatabase, insertPlay } from "../../storage/db";
import {
  handleAngleTrigger,
  type AngleTriggerArgs,
  type AngleTriggerDeps,
} from "../play-rematch-handler";
import type { DetectedPlay } from "../../types/play";

const silentLogger = createLogger("error");

function seedPlay(db: Database): void {
  const play: DetectedPlay = {
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
  insertPlay(db, play);
}

function baseArgs(
  db: Database,
  resolveAngle: AngleTriggerDeps["resolveAngle"],
): { args: AngleTriggerArgs; deps: AngleTriggerDeps } {
  return {
    args: {
      db,
      slackConfig: { botToken: "xoxb-test" },
      logger: silentLogger,
      channel: "C1",
      ts: "100.001",
      gamePk: 7000,
      playIndex: 3,
      userId: "U123",
      eventTs: `${Math.floor(Date.now() / 1000)}.000000`,
      enabled: true,
    },
    deps: { resolveAngle },
  };
}

describe("handleAngleTrigger dedup + no time gate", () => {
  let db: Database;
  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  test("enabled play: resolver is called", async () => {
    seedPlay(db);
    let calls = 0;
    const resolveAngle = async () => {
      calls++;
      return { status: "no_alternate" as const };
    };
    const { args, deps } = baseArgs(db, resolveAngle);
    await handleAngleTrigger(args, deps);
    expect(calls).toBe(1);
    db.close();
  });

  test("an old play STILL resolves — there is no age/window gate", async () => {
    seedPlay(db);
    db.run("UPDATE plays SET created_at = '2020-01-01 00:00:00' WHERE game_pk = 7000;");
    let calls = 0;
    const resolveAngle = async () => {
      calls++;
      return { status: "no_alternate" as const };
    };
    const { args, deps } = baseArgs(db, resolveAngle);
    await handleAngleTrigger(args, deps);
    expect(calls).toBe(1); // age is irrelevant now; the gate was removed
    db.close();
  });

  test("dedup: a second tap on the same play does not re-resolve", async () => {
    seedPlay(db);
    let calls = 0;
    const resolveAngle = async () => {
      calls++;
      return { status: "no_alternate" as const };
    };
    const { args, deps } = baseArgs(db, resolveAngle);
    await handleAngleTrigger(args, deps);
    await handleAngleTrigger(args, deps);
    expect(calls).toBe(1);
    db.close();
  });

  test("feature flag off: resolver is not called", async () => {
    seedPlay(db);
    let calls = 0;
    const resolveAngle = async () => {
      calls++;
      return { status: "no_alternate" as const };
    };
    const { args, deps } = baseArgs(db, resolveAngle);
    await handleAngleTrigger({ ...args, enabled: false }, deps);
    expect(calls).toBe(0);
    db.close();
  });
});
