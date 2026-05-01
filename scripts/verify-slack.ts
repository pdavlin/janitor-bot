/**
 * One-shot Slack bot-token verification.
 *
 * Posts a test message, edits it, and posts a thread reply — exactly the
 * three operations the daemon needs. If all three succeed the bot is
 * configured correctly for backfill rescues.
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_CHANNEL_ID=C... bun run scripts/verify-slack.ts
 */

const SLACK_API_BASE = "https://slack.com/api";

interface SlackResponse {
  ok: boolean;
  error?: string;
  channel?: string;
  ts?: string;
}

async function call(
  method: string,
  body: Record<string, unknown>,
  token: string,
): Promise<SlackResponse> {
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return (await response.json()) as SlackResponse;
}

async function main(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!token || !channelId) {
    console.error(
      "Missing SLACK_BOT_TOKEN and/or SLACK_CHANNEL_ID. Both are required.",
    );
    process.exit(1);
  }

  // Sanity-check the token shape so a typo fails before we hit the API.
  if (!token.startsWith("xoxb-")) {
    console.error(
      `SLACK_BOT_TOKEN does not start with "xoxb-" — paste the *Bot User OAuth Token*, not the App or User token.`,
    );
    process.exit(1);
  }

  console.log("step 1/4 — auth.test (verify token & workspace)");
  const auth = (await call("auth.test", {}, token)) as SlackResponse & {
    team?: string;
    user?: string;
    bot_id?: string;
  };
  if (!auth.ok) {
    console.error(`auth.test failed: ${auth.error}`);
    process.exit(1);
  }
  console.log(`  ok — team=${auth.team} user=${auth.user} bot_id=${auth.bot_id}`);

  console.log("step 2/4 — chat.postMessage (initial post)");
  const post = await call(
    "chat.postMessage",
    {
      channel: channelId,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":wrench: *janitor-bot verify-slack* — initial message",
          },
        },
      ],
    },
    token,
  );
  if (!post.ok || !post.ts) {
    console.error(`chat.postMessage failed: ${post.error}`);
    if (post.error === "not_in_channel" || post.error === "channel_not_found") {
      console.error(
        "  → Invite the bot to the channel: /invite @<your-bot-name>",
      );
    }
    if (post.error === "missing_scope") {
      console.error(
        "  → Add the chat:write OAuth scope and reinstall the app to your workspace.",
      );
    }
    process.exit(1);
  }
  console.log(`  ok — channel=${post.channel} ts=${post.ts}`);

  console.log("step 3/4 — chat.update (edit the original message)");
  const update = await call(
    "chat.update",
    {
      channel: post.channel,
      ts: post.ts,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":white_check_mark: *janitor-bot verify-slack* — edited (this proves chat.update works)",
          },
        },
      ],
    },
    token,
  );
  if (!update.ok) {
    console.error(`chat.update failed: ${update.error}`);
    process.exit(1);
  }
  console.log("  ok");

  console.log("step 4/4 — chat.postMessage thread_ts (thread reply)");
  const reply = await call(
    "chat.postMessage",
    {
      channel: post.channel,
      thread_ts: post.ts,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":speech_balloon: thread reply — backfill rescues will look like this",
          },
        },
      ],
    },
    token,
  );
  if (!reply.ok) {
    console.error(`thread reply failed: ${reply.error}`);
    process.exit(1);
  }
  console.log("  ok");

  console.log("");
  console.log("All four checks passed. The bot has chat:write, the channel");
  console.log("invite is in place, and chat.update + threads work.");
  console.log("");
  console.log("You can delete the test message in Slack now.");
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
