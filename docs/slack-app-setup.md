# Slack App Setup

janitor-bot supports two Slack delivery modes:

| Mode        | Trigger                                                  | Capabilities                                                         |
| ----------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| `bot_token` | `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` are both set    | Posts game messages, edits them after Savant video backfill, threads |
| `webhook`   | `SLACK_WEBHOOK_URL` is set (and bot-token mode is not)   | Posts game messages only — no edits, no threads                      |
| `disabled`  | Nothing is set                                           | Detection still runs, results land in the DB only                    |

`bot_token` mode is required for the Phase 3 backfill rescue flow (the daemon
edits the original message and posts a thread reply when a video shows up
later). Webhook mode is preserved as a fallback so a misconfigured deploy
degrades gracefully.

This document is the operator runbook for switching to `bot_token` mode.

---

## 1. Create the Slack app

1. Open https://api.slack.com/apps and click **Create New App** → **From scratch**.
2. Name it (`janitor-bot` is fine) and pick the target workspace.
3. In the left sidebar, open **OAuth & Permissions**.
4. Under **Scopes** → **Bot Token Scopes**, add **`chat:write`**. That is the
   only scope required.
5. Scroll back to the top of **OAuth & Permissions** and click
   **Install to Workspace**. Approve the prompt.
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`). This is
   `SLACK_BOT_TOKEN`.

If your workspace requires admin approval to install custom apps, the prompt
will say so. An admin needs to approve before the token is issued.

## 2. Get the channel ID

In Slack, open the target channel:

- Click the channel name at the top of the conversation pane.
- Scroll to the bottom of the panel that opens — the channel ID is shown
  (looks like `C0123456789`).

This is `SLACK_CHANNEL_ID`. Channel IDs are stable across renames; the `#name`
is not, so always use the ID.

## 3. Invite the bot to the channel

In the target channel, post:

```
/invite @janitor-bot
```

(or whatever you named the bot). Without this step, `chat.postMessage` returns
`not_in_channel` and the daemon falls back to the webhook path silently.

## 4. Verify before deploying

Run the verification script. It exercises the exact three operations the
daemon needs (`chat.postMessage`, `chat.update`, threaded reply) against the
real API:

```sh
SLACK_BOT_TOKEN=xoxb-... SLACK_CHANNEL_ID=C0123456789 bun run verify:slack
```

Expected output:

```
step 1/4 — auth.test (verify token & workspace)
  ok — team=... user=... bot_id=...
step 2/4 — chat.postMessage (initial post)
  ok — channel=C... ts=...
step 3/4 — chat.update (edit the original message)
  ok
step 4/4 — chat.postMessage thread_ts (thread reply)
  ok
All four checks passed. ...
```

The script posts a real test message you can delete from Slack afterwards.

### Troubleshooting

| Error from the script        | Fix                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `invalid_auth`               | Token is wrong or revoked. Re-copy it from **OAuth & Permissions**.            |
| `not_in_channel`             | The bot is not a member of the channel. `/invite @<bot>` and re-run.           |
| `channel_not_found`          | Channel ID is wrong, or the bot can't see it. Use the ID, not `#name`.         |
| `missing_scope`              | `chat:write` is not granted. Add it under **Scopes** and reinstall the app.    |
| `account_inactive`           | The bot user was disabled. Re-enable in workspace settings, or reinstall.      |

## 5. Deploy

Set both env vars in your service environment and restart the daemon. On the
exe.dev VM (see `~/.claude/projects/-Users-pdavlin-Development-baseball-tui-janitor-bot/memory/reference_deployment.md`), this is a systemd unit drop-in:

```ini
[Service]
Environment=SLACK_BOT_TOKEN=xoxb-...
Environment=SLACK_CHANNEL_ID=C0123456789
```

then:

```sh
systemctl daemon-reload
systemctl restart janitor-bot
```

Confirm the startup log shows `slackMode: "bot_token"`:

```sh
journalctl -u janitor-bot -n 20 | grep slackMode
```

You can leave `SLACK_WEBHOOK_URL` set if you want webhook fallback to remain
available — bot-token mode wins when both are configured.

## 6. Rollback

Unset `SLACK_BOT_TOKEN` (or both vars) and restart. The daemon reverts to
webhook mode. Existing rows in the `slack_messages` table are harmless and
can be left in place; they'll be ignored unless bot-token mode is re-enabled.

A code-level rollback is just `git revert` of the Phase 3 commit — no schema
migration to undo.

## What gets posted

- **Initial post** when a game reaches Final and outfield assists are detected
  (filtered by `MIN_TIER` if configured). Same Block Kit format as the webhook
  path; nothing visible changes for readers.
- **Edit** when the Savant video backfill loop finds a video for a play that
  was originally posted without one. The full message is re-rendered from
  current DB state — never patched in place — so all fields stay consistent.
- **Thread reply** announcing each rescued video, with a "Watch" button. One
  reply per rescued play.

Concurrent rescues for the same game are serialized in-process so two
near-simultaneous backfill events can't race `chat.update` against each other.

## Monitoring

Watch for `slack api returned non-ok` warnings:

```sh
journalctl -u janitor-bot -f | grep "slack"
```

Common signals:

- `chat.update` failure with `message_not_found` — a user deleted the original
  message. Acceptable; the daemon logs and moves on.
- 429 rate limit — Slack's Tier 3 limit (~50 req/min). The volume here is
  comfortably under, but transient bursts will log and skip that update; the
  next backfill cycle covers it.
