#!/usr/bin/env python3
"""Refuse PR changes to the frozen legacy launcher unless labelled legacy-launcher-ok.

pc-launcher/launcher.py and pc-launcher/scripts/*.ps1 are frozen (see
pc-launcher/DEPRECATED.md); the maintained worker host is hyvv/launcher.py.
Other files in pc-launcher/ (usage ingest, schemas, tests) are not guarded.

In CI it reads the pull request from GITHUB_EVENT_PATH, diffs base...HEAD and asks
the API for the PR's current labels, so adding the label and re-running the job
is enough. Outside a pull request it does nothing. Any read failure fails closed.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

LABEL = "legacy-launcher-ok"
PROTECTED = re.compile(r"^pc-launcher/(launcher\.py|scripts/[^/]+\.ps1)$")


def is_protected(path: str) -> bool:
    return bool(PROTECTED.match(path))


def decide(changed: list[str], labels: list[str]) -> tuple[bool, list[str]]:
    """(allowed, protected paths changed). The label must match exactly."""
    hits = sorted(p for p in changed if is_protected(p))
    return (not hits or LABEL in labels), hits


def _run(*cmd: str) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def main() -> int:
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as fh:
        pr = json.load(fh).get("pull_request")
    if not pr:
        print("legacy-launcher-guard: not a pull request; nothing to check")
        return 0
    changed = _run("git", "diff", "--name-only", f"{pr['base']['sha']}...HEAD").split()
    repo = os.environ["GITHUB_REPOSITORY"]
    labels = _run("gh", "api", f"repos/{repo}/issues/{pr['number']}/labels", "-q", ".[].name").split("\n")
    ok, hits = decide(changed, [label.strip("\r") for label in labels])
    if ok:
        print(f"legacy-launcher-guard: ok ({len(hits)} frozen file(s) changed)")
        return 0
    print("::error::frozen legacy launcher changed: " + ", ".join(hits))
    print(f"The maintained launcher is hyvv/launcher.py. If this change is intended, add the '{LABEL}' "
          "label and re-run this job (see pc-launcher/DEPRECATED.md).")
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, KeyError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"::error::legacy-launcher-guard could not read the PR ({type(exc).__name__}); failing closed")
        sys.exit(1)
