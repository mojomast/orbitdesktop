#!/usr/bin/env python3
"""Render public historical #92 evidence. No Git/network access or runtime discovery.

python3 scripts/hive-release-evidence.py <evidence-checkout> [--check | --write]
Default: emit the complete JS module to stdout. --check compares exact bytes.
To change qualification, separately review the new decision, pins and gates.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path


COMMIT = '2d45b5958abed555b910cbddd5bdfe5e8b22144d'
RETURN = 'release/campaign/jobs/r18-coding/return.json'
SIDECAR = 'release/campaign/jobs/r18-coding/rails-evidence.json'
PINS = {
    'release.json': '9ad3fbf40c8bade719db238835297d95fd757249972f5024a381f07319e74bb7',
    'release/DECISION.md': 'baf8a1112a18b6508cb425928443cce44dc74d9a9a7c10a6502bd91cf5ffdcef',
    'release/ci.json': '308c34420635baf603baa6305988c3e2a76bd6cb55f4fe1ec3eb4e7df8dff708',
    'release/summary.json': '1338a4e381343b39b89c0d01086a1e598cbcc9e7bc413bd890161df29a519efd',
    'release/evaluation.json': '9ea74863bffeb977b9bc089290b5940d55c8181406e4ef9b7fd787cec7bca792',
    'performance/coordinator-replay-100.json': 'c3f7f31aed44332ebf81f27d4a29b27f51ca02c5a65181ad421d04163b0810ea',
    RETURN: '6058fa382132dfb728908e47ddb519fc15a3d9241a21bd083b717482a9e3c585',
    SIDECAR: '0701a07bdd50103627d57871e541b7625cd89ebd8ec2f15d9c8888c7e34754cf',
    'release/offline-replay.json': '30662accd36bdcfdeef9a0a86cf8f4ef19acebbae4e13f2cebb77311f180668f',
}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def render(checkout):
    data = {}
    for name, expected in PINS.items():
        with (checkout / 'evidence/rails-rc' / name).open('rb') as source:
            raw = source.read(1024 * 1024)
        require(hashlib.sha256(raw).hexdigest() == expected, f'digest mismatch: {name}')
        data[name] = json.loads(raw) if name.endswith('.json') else raw.decode('utf8')

    heads = data['release.json']
    summary, ci = data['release/summary.json'], data['release/ci.json']
    evaluation = data['release/evaluation.json']
    require(heads == evaluation['tuple'] == summary['tuple'], 'qualification tuple mismatch')
    require(ci['repos'].keys() == heads.keys(), 'CI repository mismatch')
    checks = 0
    for repo, head in heads.items():
        pr = ci['repos'][repo]
        require(pr['headRefOid'] == pr['expected'] == head and pr['state'] == 'OPEN'
                and pr['isDraft'] and pr['all_reported_jobs_passed'] and pr['jobs']
                and all(job['status'] == 'SUCCESS' for job in pr['jobs']), 'CI head or checks mismatch')
        checks += len(pr['jobs'])
    require(summary['passed'] and all(not (s['failures'] or s['skipped'] or s['errors'])
                                     for s in summary['junit'].values()), 'incomplete required gate')
    tests = sum(s['tests'] for s in summary['junit'].values())
    require(tests == evaluation['junit_tests'], 'required case count mismatch')
    decision = data['release/DECISION.md'].splitlines()[0].removeprefix('# Release decision: ')
    require(decision == 'HOLD', 'requires new gate review')
    native, replay = data[RETURN], data['release/offline-replay.json']
    receiver = native['receiver_decision']['status']
    require(receiver == replay['decision']['status'] == data[SIDECAR]['receiver_decision'] == 'pending'
            and 'jobs/r18-coding/rails-evidence.json#sha256=' + PINS[SIDECAR] in native['acceptance'][0]['evidence']
            and replay['verified'] and replay['native_digest'] == native['evidence_digest'], 'RETURN binding mismatch')
    latency = evaluation['latency']
    release = dict(at=ci['observed_at'], evidenceUrl=f'https://github.com/mojomast/workflow/blob/{COMMIT}/evidence/rails-rc/release/DECISION.md',
                   tuple=heads, decision=decision, tests=tests, checks=checks,
                   canary='BLOCKED — live Windows canary not run',
                   defaultEventsMs=latency['http_default_events']['p95_ms'],
                   indexedEventsMs=latency['http_indexed_events']['p95_ms'],
                   priorIndexedEventsMs=data['performance/coordinator-replay-100.json']['events_p95_ms'],
                   receiver=receiver, loaded='unverified', notes=[
                       'Historical qualification of the four draft heads. The observation time is from the retained CI capture.',
                       'Native Windows CI passed. Pre-dispatch worker attribution and operator authorization were missing.',
                       '100,000 events, authenticated HTTP, 500 ms p95 target. The optional index passed once and missed in an earlier run; performance remains unqualified.',
                       f"View p95: {latency['http_default_view']['p95_ms']} ms default; {latency['http_indexed_view']['p95_ms']} ms indexed.",
                       f'Native RETURN SHA-256 {PINS[RETURN]}; linked sidecar SHA-256 {PINS[SIDECAR]}.',
                       'Independent offline receiver replay reproduced RED, verified GREEN and integrated GREEN. Human receiver decision remained pending.',
                       'Installed and loaded revisions, historical production-state compatibility and deployment rollback were unverified.',
                   ])
    return ('// Generated by scripts/hive-release-evidence.py from pinned Workflow #92 evidence.\n'
            'export const release = Object.freeze(' + json.dumps(release, indent=2, ensure_ascii=False) + ''');
Object.freeze(release.tuple);
Object.freeze(release.notes);

// Historical checks are inapplicable if even one head changed or is absent.
export function checksForTuple(heads) {
  const entries = Object.entries(release.tuple);
  return heads && Object.keys(heads).length === entries.length &&
    entries.every(([repo, sha]) => Object.hasOwn(heads, repo) && heads[repo] === sha)
    ? release.checks : null;
}
''').encode('utf8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkout', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--write', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    module = Path(__file__).resolve().parents[1] / 'apps/rizzstack-hive/release.js'
    try:
        out = render(args.checkout)
        if args.check:
            require(module.read_bytes() == out, 'generated release.js differs')
        elif args.write:
            module.write_bytes(out)
        else:
            sys.stdout.buffer.write(out)
    except (OSError, ValueError) as exc:
        parser.exit(1, f'{exc}\n')


if __name__ == '__main__':
    main()
