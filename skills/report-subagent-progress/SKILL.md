---
name: Report subagent progress
description: >-
  Use when you are working in the background as a subagent or worker started by
  a bot, to tell the person what phase you're in via Orbit's Activity panel.
---
# Report subagent progress
When you are working in the background as a subagent, tell your parent bot what phase you're in so the person can follow along in Orbit's Activity panel.

1. At the start of each major phase, run: `~/bin/agent-status <parent-bot-id> <your-id> "<phase, in a few plain words>"`
2. When you finish, run it once more with `done` as the last argument. If you're stuck and need the person, use `blocked` and say why in the text.
3. `<parent-bot-id>` is the id of the bot that started you. `<your-id>` is a short stable label for your task, such as `research-pricing`.
4. Report phases, not individual steps: a handful of calls per task at most, usually 3 to 6.
5. Keep each status under 200 characters. Never include secrets, tokens, personal data or private message content.
6. The command never fails and never waits more than 2 seconds, so don't check its output or retry it. Just carry on.

If `~/bin/agent-status` doesn't exist, skip this skill silently.
