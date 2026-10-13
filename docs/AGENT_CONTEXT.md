# Provider, history, and context

The agent pane keeps one provider and model on the open session. The header
menu is **provider › model**, grouped by gateway (Hermes’s API port, Grok Bot).
Each row has a health dot, the context-window size, and a tools badge. A gateway
that does not answer stays in the list and is disabled. The choice is remembered
on that pane. Changing it mid-chat does not rewrite the old session: Orbit posts
a **Switched to …** marker and forks a new session that starts from a summary.
If the new window is smaller than the current context, Orbit asks to compact
first. Resume of a session that is still running in another pane stays the
existing 409.

**Sessions** opens a history sidecar: search titles and message text, groups for
Today / Yesterday / Previous 7 days / Older, pin, rename, and a provider filter.
Opening an old session is read-only until **Resume** (same session id) or **Fork
from here** (a new session through the selected message). Hermes uses its session
catalog. Grok Bot uses paged `listAgents` and transcript tails. A fork onto a
different provider re-sends the summary because the two gateways do not share
server-side session state.

The context meter is **used / window**. Green is under 60%, amber is 60–80%, and
red is at or above 80%. **reported** means the gateway returned `usage`.
**≈ estimated** means Orbit counted characters: prose is `ceil(chars / 4)`, code
or JSON is `ceil(chars / 3)`, then multiplied by `reported / estimated` from the
last reply for that model. The tooltip splits system, tools, history, and files.
The system and tools numbers are allowances, not a hidden-prompt dump.

**Compact** asks before it runs. Automatic compact starts near 80% only for a
transcript Orbit owns (the Grok Bot pane copy, or a fork Hermes has not stored
yet). It drops old tool output first, then summarizes the middle. The summary
is a local extract of those fields, not a second model call. It keeps the goal,
decisions and why, plan and status, open TODOs, files, commands and errors,
constraints and IDs, the first user request, and the last 10 turns verbatim.
The raw transcript stays on disk under the runtime directory `transcript-raw/`
(mode 0600). Compaction changes the pane view; it does not delete the gateway
transcript.
Hermes compresses on its own gateway from reported usage; the meter shows that
state and Orbit does not compact the same Hermes session again.

## Sources

Checked 2026-10-13 unless noted as product behavior Orbit is following rather
than a quote.

- Zed’s agent panel remembers a model per thread, and providers are configured
  separately. [Agent Panel](https://zed.dev/docs/ai/agent-panel),
  [LLM providers](https://zed.dev/docs/ai/llm-providers).
- LibreChat forks from a message. [Forking](https://www.librechat.ai/docs/features/fork).
- Open WebUI groups chats by date and searches them.
  [Features](https://docs.openwebui.com/features/).
- Claude Code resumes and names sessions.
  [Common workflows](https://code.claude.com/docs/en/common-workflows).
- Anthropic’s context guide treats compaction and tool-result clearing as the
  first levers. [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
- Claude Code auto-compacts near the window and also exposes `/compact`.
  [Costs](https://code.claude.com/docs/en/costs).
- OpenCode’s `compaction.reserved` keeps headroom for the compaction call.
  [Config](https://opencode.ai/docs/config/).
- Hermes compresses from API usage, not an estimate, and keeps the head and tail.
  [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration).
