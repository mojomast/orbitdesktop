#!/bin/sh
# Install the agent-side helpers the Grok Bots app's Activity panel and group
# build board rely on. The app itself needs no install step: the server copies
# apps/grokbots/ into the runtime on start (server/builtin-apps.mjs).
#
#   ~/bin/agent-status, ~/bin/collab-board   (loopback CLIs, read keys from the runtime dir)
#   <grok workflows>/report-subagent-progress/SKILL.md
#
# Existing files that differ are left alone unless --force is given.
# Env: BIN_DIR (default ~/bin), GROK_WORKFLOWS_DIR (default $SAND_DATA_ROOT/workflows,
#      else ~/sand-data/workflows when it exists).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
BIN_DIR=${BIN_DIR:-$HOME/bin}
WF=${GROK_WORKFLOWS_DIR:-}
if [ -z "$WF" ]; then
  if [ -n "${SAND_DATA_ROOT:-}" ]; then WF="$SAND_DATA_ROOT/workflows"; elif [ -d "$HOME/sand-data" ]; then WF="$HOME/sand-data/workflows"; fi
fi
put() { # src dest mode
  if [ -e "$2" ] && ! cmp -s "$1" "$2"; then
    if [ "$FORCE" = 1 ]; then cp "$2" "$2.bak-$(date +%s)"; else echo "kept (differs, use --force): $2"; return 0; fi
  fi
  if [ -e "$2" ] && cmp -s "$1" "$2"; then echo "current: $2"; return 0; fi
  mkdir -p "$(dirname "$2")"; cp "$1" "$2"; chmod "$3" "$2"; echo "installed: $2"
}
put "$ROOT/bin/agent-status" "$BIN_DIR/agent-status" 755
put "$ROOT/bin/collab-board" "$BIN_DIR/collab-board" 755
if [ -n "$WF" ]; then put "$ROOT/skills/report-subagent-progress/SKILL.md" "$WF/report-subagent-progress/SKILL.md" 644
else echo "skipped skill: no Grok Bot workflows dir (set GROK_WORKFLOWS_DIR)"; fi
