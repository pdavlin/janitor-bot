# Deploy artifacts

Configuration files copied into prod's `/etc/systemd/system/` to wire
recurring janitor-bot work. The bot's own daemon unit
(`janitor-bot.service`) is installed separately; this directory holds
the optional add-ons.

## Weekly-review timer

Runs `bun run weekly-review --dump` every Monday at 09:00 America/Chicago.
Logs to journald under the `janitor-bot-weekly-review` unit.

### Install

From the repo root on the prod VM:

```bash
sudo cp deploy/janitor-bot-weekly-review.service /etc/systemd/system/
sudo cp deploy/janitor-bot-weekly-review.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now janitor-bot-weekly-review.timer
```

### Verify

```bash
systemctl list-timers janitor-bot-weekly-review.timer
journalctl -u janitor-bot-weekly-review.service -n 50 --no-pager
```

`list-timers` should show the next firing time (e.g.
`Mon 2026-05-11 09:00:00 CDT`) and the unit's last firing.

### Trigger an immediate run (manual override)

```bash
sudo systemctl start janitor-bot-weekly-review.service
```

This runs the same `--dump` invocation the timer would use; subsequent
timer firings are unaffected.

### Disable

```bash
sudo systemctl disable --now janitor-bot-weekly-review.timer
```

Removes the timer from the queue without uninstalling. Use this if a
prompt iteration warrants pausing automated runs while you test
revisions via `replay-prompt`.

### Notes

- The unit reads `/home/exedev/janitor-bot/.env` directly via
  `EnvironmentFile=`. Adding or rotating env vars (e.g.
  `OPERATOR_USER_ID`, `ANTHROPIC_API_KEY`) takes effect on the next
  timer firing without a daemon-reload.
- `Persistent=true` in the timer means a missed firing (e.g. the VM
  was down at 09:00) runs at the next boot. Operator DMs covering
  failure modes will still surface if the catch-up run trips a lock
  or sweep error.
- The CLI itself is idempotent on the same week: a second `bun run
  weekly-review --week-starting <same>` either succeeds (if no
  `started` row blocks) or trips `concurrent_run_blocked` and DMs the
  operator. So a manual + timer collision is recoverable.
