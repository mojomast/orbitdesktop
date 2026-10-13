# Agent pane provider, history, context, and compact

The agent chat header switches Hermes and Grok Bot per pane, lists earlier sessions, shows context use, and compacts only after confirmation. These choices follow the tools below.

## What other tools do

- Claude Code shows a context indicator and `/compact`, and auto-compacts near the window. Source: [Claude Code compact](https://code.claude.com/docs/en/compact).
- Codex CLI summarizes with `/compact` after a confirmation, and can auto-compact from a token threshold. Orbit keeps the confirmation and only suggests compacting at 80%. Source: [Codex CLI slash commands](https://developers.openai.com/codex/cli/slash-commands).
- Cursor keeps a model picker on the chat and treats the model as bound to the conversation. Source: [Cursor models](https://cursor.com/docs/models).
- OpenCode compacts with headroom rather than waiting until the window is full. Source: [OpenCode compact](https://opencode.ai/docs/commands/).
- Open WebUI and LibreChat put previous chats in a searchable sidebar grouped by date. Source: [Open WebUI chats](https://docs.openwebui.com/features/chat-conversations/).
- Hermes already compresses a session by keeping the first turns and a recent tail. Orbit surfaces that instead of summarizing the same session again.

## Provider

The header dropdown groups profiles under Hermes and Grok Bot. A dot shows whether the profile is configured. Each option shows a context-window size: the live meter window for the session that is open, and the 128k default until a session reports its own window. **Tools** is shown when the provider exposes tools. The model stays on the session that was opened. A same-provider switch keeps that session binding and posts a line in the pane. If the new window is smaller, that line suggests Compact.

A cross-provider switch does not continue the same session on the other model. It forks: Orbit writes a summary into a new session on the provider you picked and leaves the original in History. The pane shows that fork. Compact is suggested when the new window is smaller.

## History

**History** opens a side list for the current provider, or both. Search matches loaded titles and session ids. Rows are grouped into Pinned, Today, Yesterday, Previous 7 days, and Older. **Pin**, **Unpin**, and **Rename** write Orbit conversation metadata (title and pin) and do not rename the provider’s own record. **Open** resumes that same session when the provider still has it. **View** shows the bounded transcript without switching. Each message in that view has **Fork**, which copies a summary through that message into a new session and leaves the original unchanged. If the provider returns not found, Resume is unavailable and the view says the session cannot be resumed. Lists are paged at 100, the same cap as the conversation library. Grok Bot pages come from `listAgents`. Hermes pages come from `/api/sessions`.

## Context meter

The meter is `used / window`. When the gateway reports `usage.total_tokens` (or `totalTokens`, `context_tokens`, or `token_count`), the label is **reported**. Input, output, and tool counts are shown beside it when the gateway sends `prompt_tokens` / `input_tokens`, `completion_tokens` / `output_tokens`, or `tool_tokens`. Otherwise, and always for Grok Bot, Orbit estimates `characters / 4` and labels it **≈ estimated**. When a later estimate is for a profile that has already reported usage against a loaded transcript, Orbit scales that chars/4 figure by `reported / estimate`, clamped between 0.125 and 8. The label stays **≈ estimated**. The color is normal under 60%, warning from 60%, and hot from 80%.

## Compact

At about 80% the pane suggests compacting and names the 10–15k token headroom OpenCode keeps before the window is full. Compact waits for confirmation. It does not run by itself.

- Hermes already compresses a session by keeping the first 3 turns and the last 20 messages. Orbit posts to `/api/sessions/<id>/compress` only when that route exists. A 404, 405, or 501 means the command is not exposed. Orbit then leaves the session in place and does not write a second summary.
- Grok Bot has no native compression. Orbit prunes older tool outputs first, summarizes what remains, creates a new agent named from the old id, sends that summary as the first prompt, and leaves the old agent in history. The summary keeps the goal, decisions and why, plan and status, open TODOs, files touched, commands and errors, constraints and IDs, the first request, and the last 10 turns.

Raw provider transcripts are not deleted.

Fork and Grok compact use that same summary. A Hermes fork is a new Orbit session whose first pane message is the summary. The next Hermes run sends that summary as history only when the new session has no upstream transcript yet.

## Orchestration and IRC

Collab keeps agents-as-tools as the default, a required subagent brief, one worktree per coding subagent, and the depth, budget, and span limits in [Orchestration](COLLAB_ORCHESTRATION.md). IRC bind, origin, target, and approval rules are in [IRC](IRC.md).
