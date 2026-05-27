/**
 * Tests for play-rematch-handler: end-to-end orchestrator with mocked
 * agent + mocked Slack client + in-memory SQLite. The Slack web API is
 * stubbed via globalThis.fetch so the real callSlackApi path runs.
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, insertPlay } from "../../storage/db";
import { recordPlayMessage } from "../slack-messages-store";
import {
  rematchPlay,
  type RematchPlayArgs,
  type RematchPlayDeps,
} from "../play-rematch-handler";
import {
  getLatestRematchEvent,
  insertPlayRematchEvent,
} from "../play-rematch-events-store";
import type { Logger } from "../../logger";
import type { DetectedPlay } from "../../types/play";
import type { HighlightItem } from "../../types/mlb-api";
import type { RematchResult } from "../../detection/rematch-agent";

const CHANNEL = "C1";
const TS = "100.001";
const PARENT_TS = "99.000";
const GAME_PK = 7000;
const PLAY_INDEX = 3;
const USER_ID = "U_VOTER";
const EVENT_TS = "100.002";

function silentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

function basePlay(overrides: Partial<DetectedPlay> = {}): DetectedPlay {
  return {
    gamePk: GAME_PK,
    playIndex: PLAY_INDEX,
    date: "2026-05-27",
    fielderId: 676962,
    fielderName: "Mookie Betts",
    fielderPosition: "RF",
    runnerId: 1,
    runnerName: "Runner",
    targetBase: "3B",
    batterName: "Batter",
    inning: 7,
    halfInning: "top",
    awayScore: 1,
    homeScore: 2,
    awayTeam: "LAD",
    homeTeam: "ATL",
    description: "Betts throws out runner at third base.",
    creditChain: "RF -> 3B",
    tier: "high",
    outs: 1,
    runnersOn: "1st",
    isOverturned: false,
    playId: null,
    fetchStatus: null,
    videoUrl: "https://video.example.com/old.mp4",
    videoTitle: "Old Title",
    ...overrides,
  };
}

function candidate(
  id: string,
  url: string,
  title = `Title ${id}`,
  description = `Description for ${id}`,
): HighlightItem {
  return {
    id,
    title,
    description,
    playbacks: [{ name: "mp4Avc", url, width: "1280", height: "720" }],
  };
}

function makeArgs(
  db: Database,
  overrides: Partial<RematchPlayArgs> = {},
): RematchPlayArgs {
  return {
    db,
    slackConfig: { botToken: "xoxb-test", channelId: CHANNEL },
    logger: silentLogger(),
    channel: CHANNEL,
    ts: TS,
    gamePk: GAME_PK,
    playIndex: PLAY_INDEX,
    userId: USER_ID,
    eventTs: EVENT_TS,
    enabled: true,
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  body: string | null;
}

function stubSlackFetch(opts: {
  updateOk?: boolean;
  postOk?: boolean;
  calls: FetchCall[];
}) {
  const updateOk = opts.updateOk ?? true;
  const postOk = opts.postOk ?? true;
  return mock(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? init.body : null;
    opts.calls.push({ url, body });
    if (url.includes("/chat.update")) {
      return new Response(JSON.stringify({ ok: updateOk }), { status: 200 });
    }
    if (url.includes("/chat.postMessage")) {
      return new Response(
        JSON.stringify({ ok: postOk, channel: CHANNEL, ts: "200.000" }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  });
}

describe("rematchPlay orchestrator", () => {
  let db: Database;
  let originalFetch: typeof fetch;
  let fetchCalls: FetchCall[];

  beforeEach(() => {
    db = createDatabase(":memory:");
    fetchCalls = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  test("swap happy path: agent picks new id, plays row + slack edit + thread reply", async () => {
    insertPlay(db, basePlay({ videoUrl: "https://old.example.com/a.mp4" }));
    recordPlayMessage(db, GAME_PK, PLAY_INDEX, CHANNEL, TS, PARENT_TS);

    const candidates = [
      candidate("vid-old", "https://old.example.com/a.mp4"),
      candidate("vid-new", "https://new.example.com/b.mp4", "New Highlight"),
    ];

    const rematchSpy: RematchPlayDeps["rematchVideo"] = mock(
      async (_apiKey, _model, _input, _logger) =>
        ({ decision: "swapped", videoId: "vid-new", reason: "better keywords" }) as RematchResult,
    );
    const fetchVideos = mock(async () => candidates);
    globalThis.fetch = stubSlackFetch({ calls: fetchCalls }) as unknown as typeof fetch;

    const deps: RematchPlayDeps = {
      rematchVideo: rematchSpy,
      fetchGameVideos: fetchVideos,
    };
    await rematchPlay(makeArgs(db), deps);

    expect(rematchSpy).toHaveBeenCalledTimes(1);
    const callArgs = (rematchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(callArgs[2]).toMatchObject({
      currentVideoId: "vid-old",
      gamePk: GAME_PK,
    });

    const updatedRow = db
      .prepare("SELECT video_url, video_title FROM plays WHERE game_pk = ? AND play_index = ?;")
      .get(GAME_PK, PLAY_INDEX) as { video_url: string; video_title: string };
    expect(updatedRow.video_url).toBe("https://new.example.com/b.mp4");
    expect(updatedRow.video_title).toBe("New Highlight");

    const event = getLatestRematchEvent(db, GAME_PK, PLAY_INDEX);
    expect(event).toMatchObject({
      decision: "swapped",
      priorVideoUrl: "https://old.example.com/a.mp4",
      newVideoUrl: "https://new.example.com/b.mp4",
      agentReason: "better keywords",
      userId: USER_ID,
    });

    expect(fetchCalls.some((c) => c.url.includes("/chat.update"))).toBe(true);
    const postCall = fetchCalls.find((c) => c.url.includes("/chat.postMessage"));
    expect(postCall).toBeDefined();
    expect(postCall!.body).toContain("Re-matched video");
    expect(postCall!.body).not.toContain("edit failed");
  });

  test("dedupe: prior event with same prior_video_url short-circuits", async () => {
    insertPlay(db, basePlay({ videoUrl: "https://old.example.com/a.mp4" }));
    recordPlayMessage(db, GAME_PK, PLAY_INDEX, CHANNEL, TS, PARENT_TS);
    insertPlayRematchEvent(db, {
      gamePk: GAME_PK,
      playIndex: PLAY_INDEX,
      userId: "U_PRIOR",
      priorVideoUrl: "https://old.example.com/a.mp4",
      newVideoUrl: "https://old.example.com/a.mp4",
      decision: "agreed",
      agentReason: "prior tap",
      eventTs: "1",
    });

    const rematchSpy = mock(async () => ({ decision: "agreed" }) as RematchResult);
    const fetchVideos = mock(async () => []);
    globalThis.fetch = stubSlackFetch({ calls: fetchCalls }) as unknown as typeof fetch;

    await rematchPlay(makeArgs(db), {
      rematchVideo: rematchSpy as RematchPlayDeps["rematchVideo"],
      fetchGameVideos: fetchVideos,
    });

    expect(rematchSpy).not.toHaveBeenCalled();
    expect(fetchVideos).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    const latest = getLatestRematchEvent(db, GAME_PK, PLAY_INDEX);
    expect(latest).toMatchObject({
      decision: "deduped",
      priorVideoUrl: "https://old.example.com/a.mp4",
      newVideoUrl: null,
      userId: USER_ID,
    });
  });

  test("null-video dedupe: both prior and current are null", async () => {
    insertPlay(db, basePlay({ videoUrl: null, videoTitle: null }));
    recordPlayMessage(db, GAME_PK, PLAY_INDEX, CHANNEL, TS, PARENT_TS);
    insertPlayRematchEvent(db, {
      gamePk: GAME_PK,
      playIndex: PLAY_INDEX,
      userId: "U_PRIOR",
      priorVideoUrl: null,
      newVideoUrl: null,
      decision: "no_match",
      agentReason: null,
      eventTs: "1",
    });

    const rematchSpy = mock(async () => ({ decision: "no_match" }) as RematchResult);
    const fetchVideos = mock(async () => []);
    globalThis.fetch = stubSlackFetch({ calls: fetchCalls }) as unknown as typeof fetch;

    await rematchPlay(makeArgs(db), {
      rematchVideo: rematchSpy as RematchPlayDeps["rematchVideo"],
      fetchGameVideos: fetchVideos,
    });

    expect(rematchSpy).not.toHaveBeenCalled();
    const latest = getLatestRematchEvent(db, GAME_PK, PLAY_INDEX);
    expect(latest?.decision).toBe("deduped");
  });

  test("eligible after change: plays.video_url changed since prior event", async () => {
    insertPlay(db, basePlay({ videoUrl: "https://new.example.com/b.mp4" }));
    recordPlayMessage(db, GAME_PK, PLAY_INDEX, CHANNEL, TS, PARENT_TS);
    insertPlayRematchEvent(db, {
      gamePk: GAME_PK,
      playIndex: PLAY_INDEX,
      userId: "U_PRIOR",
      priorVideoUrl: "https://old.example.com/a.mp4",
      newVideoUrl: "https://old.example.com/a.mp4",
      decision: "agreed",
      agentReason: null,
      eventTs: "1",
    });

    const rematchSpy = mock(async () => ({ decision: "agreed" }) as RematchResult);
    const fetchVideos = mock(async () => [
      candidate("vid-new", "https://new.example.com/b.mp4"),
    ]);
    globalThis.fetch = stubSlackFetch({ calls: fetchCalls }) as unknown as typeof fetch;

    await rematchPlay(makeArgs(db), {
      rematchVideo: rematchSpy as RematchPlayDeps["rematchVideo"],
      fetchGameVideos: fetchVideos,
    });

    expect(rematchSpy).toHaveBeenCalledTimes(1);
  });

  test("agreed: no plays update, no chat.update, thread reply posted", async () => {
    insertPlay(db, basePlay({ videoUrl: "https://old.example.com/a.mp4" }));
    recordPlayMessage(db, GAME_PK, PLAY_INDEX, CHANNEL, TS, PARENT_TS);
    const candidates = [
      candidate("vid-old", "https://old.example.com/a.mp4"),
    ];

    const rematchSpy = mock(async () =>
      ({ decision: "agreed", reason: "looks right" }) as RematchResult,
    );
    const fetchVideos = mock(async () => candidates);
    globalThis.fetch = stubSlackFetch({ calls: fetchCalls }) as unknown as typeof fetch;

    await rematchPlay(makeArgs(db), {
      rematchVideo: rematchSpy as RematchPlayDeps["rematchVideo"],
      fetchGameVideos: fetchVideos,
    });

    const row = db
      .prepare("SELECT video_url FROM plays WHERE game_pk = ?;")
      .get(GAME_PK) as { video_url: string };
    expect(row.video_url).toBe("https://old.example.com/a.mp4");

    expect(fetchCalls.some((c) => c.url.includes("/chat.update"))).toBe(false);
    const postCall = fetchCalls.find((c) => c.url.includes("/chat.postMessage"));
    expect(postCall!.body).toContain("agreed with the current video");

    const latest = getLatestRematchEvent(db, GAME_PK, PLAY_INDEX);
    expect(latest).toMatchObject({
      decision: "agreed",
      agentReason: "looks right",
    });
  });

  test("no_match: no plays update, no chat.update, thread reply posted", async () => {
    insertPlay(db, basePlay({ videoUrl: "https://old.example.com/a.mp4" }));
    recordPlayMessage(db, GAME_PK, PLAY_INDEX, CHANNEL, TS, PARENT_TS);

    const rematchSpy = mock(async () =>
      ({ decision: "no_match", reason: "nothing matched" }) as RematchResult,
    );
    const fetchVideos = mock(async () => [
      candidate("vid-old", "https://old.example.com/a.mp4"),
    ]);
    globalThis.fetch = stubSlackFetch({ calls: fetchCalls }) as unknown as typeof fetch;

    await rematchPlay(makeArgs(db), {
      rematchVideo: rematchSpy as RematchPlayDeps["rematchVideo"],
      fetchGameVideos: fetchVideos,
    });

    expect(fetchCalls.some((c) => c.url.includes("/chat.update"))).toBe(false);
    const postCall = fetchCalls.find((c) => c.url.includes("/chat.postMessage"));
    expect(postCall!.body).toContain("could not identify");

    const latest = getLatestRematchEvent(db, GAME_PK, PLAY_INDEX);
    expect(latest).toMatchObject({
      decision: "no_match",
      agentReason: "nothing matched",
    });
  });

  test("agent throws: thread reply posted, no event row written", async () => {
    insertPlay(db, basePlay({ videoUrl: "https://old.example.com/a.mp4" }));
    recordPlayMessage(db, GAME_PK, PLAY_INDEX, CHANNEL, TS, PARENT_TS);

    const rematchSpy = mock(async () => {
      throw new Error("anthropic 500");
    });
    const fetchVideos = mock(async () => [
      candidate("vid-old", "https://old.example.com/a.mp4"),
    ]);
    globalThis.fetch = stubSlackFetch({ calls: fetchCalls }) as unknown as typeof fetch;

    await rematchPlay(makeArgs(db), {
      rematchVideo: rematchSpy as RematchPlayDeps["rematchVideo"],
      fetchGameVideos: fetchVideos,
    });

    const postCall = fetchCalls.find((c) => c.url.includes("/chat.postMessage"));
    expect(postCall!.body).toContain("Re-match request failed");

    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM play_rematch_events;").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });

  test("chat.update fails after swap: plays row still updated, thread reply notes failure", async () => {
    insertPlay(db, basePlay({ videoUrl: "https://old.example.com/a.mp4" }));
    recordPlayMessage(db, GAME_PK, PLAY_INDEX, CHANNEL, TS, PARENT_TS);

    const candidates = [
      candidate("vid-new", "https://new.example.com/b.mp4", "New Highlight"),
    ];
    const rematchSpy = mock(async () =>
      ({ decision: "swapped", videoId: "vid-new", reason: "x" }) as RematchResult,
    );
    const fetchVideos = mock(async () => candidates);
    globalThis.fetch = stubSlackFetch({ calls: fetchCalls, updateOk: false }) as unknown as typeof fetch;

    await rematchPlay(makeArgs(db), {
      rematchVideo: rematchSpy as RematchPlayDeps["rematchVideo"],
      fetchGameVideos: fetchVideos,
    });

    const row = db
      .prepare("SELECT video_url FROM plays WHERE game_pk = ?;")
      .get(GAME_PK) as { video_url: string };
    expect(row.video_url).toBe("https://new.example.com/b.mp4");

    const postCall = fetchCalls.find((c) => c.url.includes("/chat.postMessage"));
    expect(postCall!.body).toContain("edit failed");

    const latest = getLatestRematchEvent(db, GAME_PK, PLAY_INDEX);
    expect(latest?.decision).toBe("swapped");
  });

  test("feature flag disabled: no agent call, no DB writes, no Slack calls", async () => {
    insertPlay(db, basePlay());
    recordPlayMessage(db, GAME_PK, PLAY_INDEX, CHANNEL, TS, PARENT_TS);

    const rematchSpy = mock(async () => ({ decision: "agreed" }) as RematchResult);
    const fetchVideos = mock(async () => []);
    globalThis.fetch = stubSlackFetch({ calls: fetchCalls }) as unknown as typeof fetch;

    await rematchPlay(makeArgs(db, { enabled: false }), {
      rematchVideo: rematchSpy as RematchPlayDeps["rematchVideo"],
      fetchGameVideos: fetchVideos,
    });

    expect(rematchSpy).not.toHaveBeenCalled();
    expect(fetchVideos).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM play_rematch_events;").get() as { c: number }).c,
    ).toBe(0);
  });

  test("empty candidate list: no agent call, no_match event, thread reply", async () => {
    insertPlay(db, basePlay({ videoUrl: "https://old.example.com/a.mp4" }));
    recordPlayMessage(db, GAME_PK, PLAY_INDEX, CHANNEL, TS, PARENT_TS);

    const rematchSpy = mock(async () => ({ decision: "agreed" }) as RematchResult);
    const fetchVideos = mock(async () => [] as HighlightItem[]);
    globalThis.fetch = stubSlackFetch({ calls: fetchCalls }) as unknown as typeof fetch;

    await rematchPlay(makeArgs(db), {
      rematchVideo: rematchSpy as RematchPlayDeps["rematchVideo"],
      fetchGameVideos: fetchVideos,
    });

    expect(rematchSpy).not.toHaveBeenCalled();
    const latest = getLatestRematchEvent(db, GAME_PK, PLAY_INDEX);
    expect(latest).toMatchObject({
      decision: "no_match",
      agentReason: "no candidates available from MLB API",
    });
    const postCall = fetchCalls.find((c) => c.url.includes("/chat.postMessage"));
    expect(postCall!.body).toContain("could not identify");
  });
});
