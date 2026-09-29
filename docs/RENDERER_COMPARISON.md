# Desktop or Docking: a hands-on comparison

Orbit currently offers two ways to arrange the same workspace. **Desktop** is
the default renderer. **Docking** is an experimental, opt-in arrangement system.
Neither changes the Hermes model, permissions, chat mode or Workbench executor.

| Question | Desktop (default) | Docking (experimental) |
| --- | --- | --- |
| What does it feel like? | A desktop of movable windows | An IDE with tiled panels and tab groups |
| How do I organize work? | Move/resize windows; overlap or arrange them | Dock beside another window, group as tabs, resize dividers, float groups |
| What is being moved? | Orbit windows containing their panes | Those same whole windows; inner panes stay under Orbit's control |
| What stays the same? | Chats, terminals, apps, themes, projects and approvals | The same chats, terminals, apps, themes, projects and approvals |
| What is saved? | Normal window layout | Separate docking placement alongside the normal workspace layout |
| Who might prefer it? | Flexible spatial organization and free placement | Predictable side-by-side work and compact task groups |
| Release status | Default | Opt-in; Chromium continuity evidence, not cross-browser certification |

**Renderer is different from view and chat mode.** Windows/spatial/focus are ways
to view the workspace. Normal/Workbench are modes inside the agent pane. Changing
a renderer does not change either mode's execution authority.

## Open each renderer

On your Orbit host:

- Desktop: `/` (or `/?renderer=default`).
- Docking: `/?renderer=docking`.

The query flag is read from the URL; it is not a saved renderer preference.
Return to `/` to use Desktop again. Docking uses native connected-DOM movement;
unsupported browsers show an explicit notice and retain the default renderer.

In the updated candidate, arrangement commands live in **Docking** beside the
host connection button in the top Orbit bar. Open it to select source/target
windows and tab, dock, float or return to grid. Escape closes it. Full viewport
keeps the Docking toggle at the upper right.

These URLs select a renderer, **not a separate workspace**. Tabs in the same
browser profile normally share workspace identity and server state. Use one tab
at a time for a quick look; use deliberately provisioned disposable workspaces
for the arrangement/recovery comparison below. A private window alone is not a
complete isolated backend/runtime fixture. Automated tests use separate browser
contexts, fresh workspace IDs, private runtime and tmux state, and synthetic chat.

## Ten-minute owner walkthrough

Use matching sample content in three windows: **Chat**, **Notes**, **Terminal**.
Use the same theme and screen size for both passes. The operator should provide
two explicitly labeled test workspaces and test links before rearranging them.
The comparison need not send anything to a paid model.

| Task | Desktop pass | Docking pass | Notice |
| --- | --- | --- | --- |
| Keep chat and notes visible | Move/resize them side by side | Select Chat as Docking window, Notes as Docking target, then Dock left/right | Effort, overlap, readable message width |
| Make more room for notes | Resize its window | Drag the divider between panels | Predictability and minimum usable width |
| Switch to terminal | Select its window or taskbar entry | Select its panel/tab | How easily you find it and where keyboard focus lands |
| Group related work | Arrange nearby windows | Select a window/target and choose Tab to target | Whether hidden tabs help or conceal needed information |
| Temporarily separate a window | Move it away | Float window, then Return to grid | Ease of recovering the arrangement |
| Preserve work while arranging | Type an unsent chat draft and sample app draft, then rearrange | Repeat with the same draft/task | Draft, caret, scroll and terminal identity retention |
| Return after reload | Reload, reconnect the test host | Reload the docking URL and reconnect | Saved placement, conversation, chat draft and tmux reattachment |

Reload recreates iframe documents: an app's unsaved in-memory draft is not promised
to survive reload. The draft-retention assertion for embedded apps applies to
layout-only movement on supported browsers. Persistent terminals reattach to tmux;
reloading is not evidence that arbitrary application state is durable.

For each renderer, rate **finding work**, **arranging work**, **chat comfort**,
**keyboard use**, and **visual clarity** from 1–5. Record the first confusing step,
any lost focus or clipping, and which arrangement you would use every day. A
successful terminal-continuity test does not decide these preference questions.

## Shared chat checks

In both test workspaces:

1. Leave chat idle for 30 seconds. Send should remain visually stable.
2. Find New chat without instructions, start a conversation, then return to the
   old conversation. Confirm its transcript and draft are preserved.
3. Send one synthetic fixture message during a delayed background refresh. Confirm
   exactly one response; a real binding conflict must retain the draft and explain
   what changed.
4. Inspect tools, switch Normal/Workbench and return. Confirm the original composer
   draft and selection are intact and navigation does not start work.

At the `3a0262a` assessment baseline, New chat was inside **⋯ → Conversation
settings** and shared-state polling toggled Send's disabled state. The updated
candidate places New chat and History above the conversation and separates
passive refresh from foreground actions. Check the loaded build before following
the walkthrough; see [readiness and acceptance](RELEASE_READINESS_PLAN.md).

## Operator verification

Use the isolated browser harnesses at the exact candidate revision:

- `tests/renderer-parity.browser.py --pty`: same deterministic continuity workload
  in both renderers, including private tmux identity and iframe drafts.
- `tests/docking-persistence.browser.py`: tab/float placement persistence and
  reload behavior.
- `tests/agent-selection.browser.py`: fresh chat and profile/session selection.
- `tests/agent-pane-ux.browser.py`: agent states, responsive presentation and tool
  inspection in both renderers.
- `tests/theme-preset-switch.browser.py`: preset switching and custom-style
  preservation in both renderers.

Several older harnesses expect a `dist/` next to their copied source. Build and run
them in a disposable source copy with an isolated dist; the default `npm run build`
produces a scratch dist and does not refresh a checkout's served `dist/`. Never
substitute stale assets for the candidate under test.

See [optional docking internals](OPTIONAL_DOCKING.md),
[continuity guarantees](RUNTIME_CONTINUITY.md), and
[parity test semantics](RENDERER_PARITY.md) for the technical boundaries.
