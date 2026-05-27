/**
 * Re-match agent: given a play description and a list of candidate
 * highlight videos for the same game, ask the LLM to pick the best
 * match (or decline). Wraps the same Anthropic Messages tool-use shape
 * used by the weekly-review agent, with a single mandatory tool
 * (`pick_video`) and a much smaller per-call budget.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import {
  AgentResponseError,
  AgentTimeoutError,
  defaultClient,
  estimateCost,
  type AgentClient,
  type AgentMessage,
  type ContentBlock,
} from "../cli/weekly-review/agent";
import type { Logger } from "../logger";

export interface RematchCandidate {
  /** Stable id from the MLB content API highlight item. */
  id: string;
  /** The free-text description the agent reads to pick. */
  description: string;
  /** Optional title; surfaced to the agent as an extra signal. */
  title?: string;
}

export interface RematchInput {
  /** MLB play description text (`plays.description`). */
  playDescription: string;
  /** id of the currently displayed video, or null when first pass found nothing. */
  currentVideoId: string | null;
  /** Full game video list; the agent picks one of these by id. */
  candidates: RematchCandidate[];
  /** For logging only. */
  gamePk: number;
}

export type RematchResult =
  | { decision: "swapped"; videoId: string; reason?: string }
  | { decision: "agreed"; reason?: string }
  | { decision: "no_match"; reason?: string };

const ATTEMPT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1024;
const MAX_ROUND_TRIPS = 3;

const PICK_VIDEO_TOOL: Tool = {
  name: "pick_video",
  description:
    "Pick the highlight video whose description best matches the play. " +
    "Return null for video_id if no candidate is a clear match.",
  input_schema: {
    type: "object",
    properties: {
      video_id: {
        type: ["string", "null"],
        description:
          "id of the chosen video from the candidate list, or null when no candidate matches.",
      },
      reason: {
        type: "string",
        description: "Brief explanation of the choice for audit logging.",
      },
    },
    required: ["video_id", "reason"],
  },
};

const SYSTEM_PROMPT =
  "You are an expert at matching MLB play descriptions to highlight video descriptions.\n\n" +
  "You will receive:\n" +
  "- A play description.\n" +
  "- The id of the video currently attached to this play (may be null if none has been matched yet).\n" +
  "- A numbered list of candidate videos for the same game, each with an id and a description.\n\n" +
  "Call the `pick_video` tool exactly once.\n" +
  "- Return the id of the candidate that best matches the play.\n" +
  "- If the currently attached video is already the best match, return its id (only valid when a current id was provided).\n" +
  "- If no candidate is a clear match, return null.\n" +
  "- Always include a brief reason.";

export async function rematchVideo(
  apiKey: string,
  model: string,
  input: RematchInput,
  logger: Logger,
  clientOverride?: AgentClient,
): Promise<RematchResult> {
  const client = clientOverride ?? defaultClient(apiKey);
  const user = buildUserPrompt(input);
  const messages: AgentMessage[] = [{ role: "user", content: user }];
  const candidateIds = new Set(input.candidates.map((c) => c.id));

  let totalCost = 0;
  let roundTrips = 0;

  const attempt = async () =>
    Promise.race([
      client.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
        temperature: 0,
        tools: [PICK_VIDEO_TOOL],
      }),
      Bun.sleep(ATTEMPT_TIMEOUT_MS).then(() => {
        throw new AgentTimeoutError(
          `Anthropic call exceeded ${ATTEMPT_TIMEOUT_MS}ms`,
        );
      }),
    ]);

  for (let round = 0; round < MAX_ROUND_TRIPS; round++) {
    let response: Awaited<ReturnType<AgentClient["create"]>>;
    try {
      response = await attempt();
    } catch (err) {
      if (!isTransient(err)) throw err;
      logger.warn("rematch agent call failed, retrying once", {
        error: err instanceof Error ? err.message : String(err),
        round,
        gamePk: input.gamePk,
      });
      await Bun.sleep(RETRY_DELAY_MS);
      response = await attempt();
    }

    roundTrips++;
    totalCost += estimateCost(
      model,
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    const toolUse = response.content.find(
      (b): b is ContentBlock & {
        type: "tool_use";
        id: string;
        name: string;
        input: unknown;
      } =>
        b.type === "tool_use" &&
        b.name === "pick_video" &&
        typeof b.id === "string",
    );

    if (toolUse) {
      const result = interpretToolCall(toolUse.input, input, candidateIds, logger);
      logger.info("rematch agent decision", {
        gamePk: input.gamePk,
        priorVideoId: input.currentVideoId,
        decision: result.decision,
        newVideoId: result.decision === "swapped" ? result.videoId : null,
        costUsd: totalCost,
        roundTrips,
      });
      return result;
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content:
        "Call the `pick_video` tool now. Return the chosen candidate id or null if nothing matches.",
    });
  }

  logger.warn("rematch agent did not call pick_video within MAX_ROUND_TRIPS", {
    gamePk: input.gamePk,
    maxRoundTrips: MAX_ROUND_TRIPS,
    costUsd: totalCost,
  });
  return { decision: "no_match", reason: "agent did not call pick_video" };
}

function buildUserPrompt(input: RematchInput): string {
  const currentLine =
    input.currentVideoId === null ? "none" : input.currentVideoId;
  const candidateLines = input.candidates.map((c) => {
    const title = c.title ? ` ${c.title} —` : "";
    return `[${c.id}]${title} ${c.description}`;
  });
  return [
    `Play description:\n${input.playDescription}`,
    "",
    `Currently attached video id: ${currentLine}`,
    "",
    "Candidates:",
    ...candidateLines,
  ].join("\n");
}

function interpretToolCall(
  rawInput: unknown,
  input: RematchInput,
  candidateIds: Set<string>,
  logger: Logger,
): RematchResult {
  if (!rawInput || typeof rawInput !== "object") {
    logger.warn("rematch agent returned malformed pick_video input", {
      gamePk: input.gamePk,
      rawInput,
    });
    return { decision: "no_match", reason: "malformed tool input" };
  }
  const obj = rawInput as Record<string, unknown>;
  const videoIdRaw = obj.video_id;
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;

  if (videoIdRaw === null) {
    return { decision: "no_match", reason };
  }
  if (typeof videoIdRaw !== "string") {
    logger.warn("rematch agent returned non-string video_id", {
      gamePk: input.gamePk,
      videoIdRaw,
    });
    return { decision: "no_match", reason: reason ?? "malformed video_id" };
  }
  if (!candidateIds.has(videoIdRaw)) {
    logger.warn("rematch agent picked video_id not in candidates", {
      gamePk: input.gamePk,
      videoId: videoIdRaw,
    });
    return { decision: "no_match", reason: reason ?? "video_id not in candidates" };
  }
  if (videoIdRaw === input.currentVideoId) {
    return { decision: "agreed", reason };
  }
  return { decision: "swapped", videoId: videoIdRaw, reason };
}

function isTransient(err: unknown): boolean {
  if (err instanceof AgentTimeoutError) return true;
  if (err instanceof AgentResponseError) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (typeof status === "number" && status >= 500) return true;
    return false;
  }
  if (err instanceof Error && err.message.toLowerCase().includes("network")) {
    return true;
  }
  return false;
}
