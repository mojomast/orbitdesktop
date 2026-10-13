# Agent pane provider, history, context, and compact

The agent chat header switches Hermes and Grok Bot per pane, lists earlier sessions, shows context use, and compacts only after confirmation. These choices follow the tools below.

## What other tools do

- Claude Code shows a context indicator and `/compact`, and auto-compacts near the window. Source: [Claude Code compact](https://code.claude.com/docs/en/compact).
- Cursor keeps a model picker on the chat and treats the model as bound to the conversation. Source: [Cursor models](https://cursor.com/docs/models).
- OpenCode compacts with headroom rather than waiting until the window is full. Source: [OpenCode compact](https://opencode.ai/docs/commands/).
- Open WebUI and LibreChat put previous chats in a searchable sidebar grouped by date. Source: [Open WebUI chats](https://docs.openwebui.com/features/chat-conversations/).
- Hermes already compresses a session by keeping the first turns and a recent tail. Orbit surfaces that instead of summarizing the same session again.

## Provider

The header dropdown groups Hermes profiles and Grok Bot. A dot shows whether the profile is configured. The option label includes the default 128k window. **Tools** is shown when the provider exposes tools. The pane binding remembers the choice. Switching posts a line in the pane. If the new window is smaller than the previous one, that line suggests Compact. The model stays on the session that was opened.

## History

**History** opens a side list for the current provider, or both. Search matches loaded titles and session ids. Rows are grouped into Pinned, Today, Yesterday, Previous 7 days, and Older. **Open** resumes through the existing session selection when the provider still has that session. **View** shows the bounded transcript without switching. If the provider returns not found, the view says the session cannot be resumed. Lists are paged at 100, the same cap as the conversation library. Grok Bot pages come from `listAgents`. Hermes pages come from `/api/sessions`.

## Context meter

The meter is `used / window`. Hermes uses gateway `usage.total_tokens` when the session reports it, labeled **reported**. Otherwise, and always for Grok Bot, Orbit estimates `characters / 4` from the loaded transcript and labels it **≈ estimated**. The color is normal under 60%, warning from 60%, and hot from 80%. At 80% the pane suggests compacting. It does not compact by itself.

## Compact

Compact asks for confirmation and shows the result.

- Hermes: Orbit posts to `/api/sessions/<id>/compress` when that route exists. A 404, 405, or 501 means the command is not exposed. Orbit then leaves the session in place and says that Hermes already keeps the first 3 turns and the last 20 messages.
- Grok Bot: Orbit summarizes the transcript (goal, decision lines, file names, and the last 10 turns), creates a new agent named from the old id, sends that summary as the first prompt, and leaves the old agent in history.

Raw provider transcripts are not deleted.
