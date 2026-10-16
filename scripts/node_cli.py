#!/usr/bin/env python3
"""Locate a Node binary that can run the workspace bundle CLI.

`scripts/workspace_bundles.mjs` is TS-stripped, so it needs a Node that accepts
`--experimental-strip-types` (Node >= 22). Shelling out to a bare `node` picks up
whatever is first on PATH, which on this host is Node 20 — the CLI then dies with
"bad option: --experimental-strip-types" and publish reports a bundle indexing
failure even though the files landed. Resolve deliberately instead.

Order: $ORBIT_NODE, versioned names on PATH, then known install locations. The
first candidate that reports major >= 22 wins; if none qualifies, fall back to
`node` so callers behave exactly as before this helper existed.
"""
import glob
import os
import re
import shutil
import subprocess

MINIMUM_MAJOR = 22
PATTERNS = (
    '~/.local/node*/bin/node',
    '~/.nvm/versions/node/v2[2-9]*/bin/node',
    '/usr/local/bin/node2[2-9]',
    '/opt/node*/bin/node',
)
_resolved = None


def _major(candidate):
    try:
        completed = subprocess.run([candidate, '--version'], capture_output=True, timeout=30,
                                   check=False, text=True)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.fullmatch(r'v(\d+)\..*', (completed.stdout or '').strip())
    return int(match.group(1)) if match else None


def candidates():
    seen, ordered = set(), []

    def add(candidate):
        if candidate and candidate not in seen:
            seen.add(candidate)
            ordered.append(candidate)

    add(os.environ.get('ORBIT_NODE'))
    for name in ('node22', 'nodejs22', 'node'):
        add(shutil.which(name))
    for pattern in PATTERNS:
        for match in sorted(glob.glob(os.path.expanduser(pattern))):
            add(match)
    return ordered


def resolve_node():
    """Path to a Node that supports --experimental-strip-types."""
    global _resolved
    if _resolved is None:
        for candidate in candidates():
            major = _major(candidate)
            if major is not None and major >= MINIMUM_MAJOR:
                _resolved = candidate
                break
        else:
            _resolved = shutil.which('node') or 'node'
    return _resolved


if __name__ == '__main__':
    print(resolve_node())
