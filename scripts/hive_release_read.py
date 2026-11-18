#!/usr/bin/env python3
"""Publish a point-in-time observation of enrolled public GitHub refs to a private directory."""

import argparse
import http.client
import json
import os
import re
import secrets
import signal
import stat
from datetime import datetime, timezone


HOST = 'api.github.com'
ORIGIN = 'https://' + HOST
ENROLLED = {
    'mojomast/workflow': (1455472841, (91,)),
    'mojomast/bundlebees': (1454339884, (82,)),
    'mojomast/hyvv': (1455851481, (26,)),
    'mojomast/orbitdesktop': (1377703993, (46, 48)),
}
QUERY = 'check-runs?filter=latest&per_page=50&page=1'
MAX_INPUT = 2 * 1024 * 1024
MAX_OUTPUT = 16 * 1024
DEADLINE = 90


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def _pairs(items):
    result = dict(items)
    require(len(items) == len(result), 'duplicate GitHub field')
    return result


def _get(path):
    # The transport accepts no host, arbitrary path, redirects, ambient tokens,
    # proxies or GitHub-supplied URLs (including pagination links).
    permitted = False
    for repo, (_, numbers) in ENROLLED.items():
        base = '/repos/' + repo
        if (path in (base, base + '/git/ref/heads/main') or
            any(path == f'{base}/pulls/{n}' for n in numbers) or
            re.fullmatch(re.escape(base) + '/commits/[a-f0-9]{40}/' + re.escape(QUERY), path)):
            permitted = True
            break
    require(permitted, 'unenrolled GitHub resource')
    conn = http.client.HTTPSConnection(HOST, timeout=6)
    try:
        conn.request('GET', path, headers={'User-Agent': 'Orbit-Hive-Public-Release-Read/1',
                     'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                     'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity'})
        with conn.getresponse() as r:
            require(r.status == 200, f'GitHub HTTP {r.status}')
            require(r.getheader('Content-Type', '').split(';')[0] == 'application/json'
                    and not r.getheader('Content-Encoding'), 'unexpected GitHub representation')
            body = r.read(MAX_INPUT + 1)
            require(len(body) <= MAX_INPUT, 'GitHub response exceeds byte limit')
            data = json.loads(body.decode('utf-8'), object_pairs_hook=_pairs)
            require(isinstance(data, dict), 'expected a GitHub object')
            return data, 'rel="next"' in r.getheader('Link', '')
    finally:
        conn.close()


def _timestamp(dt):
    return dt.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _sha(s):
    require(isinstance(s, str) and re.fullmatch('[a-f0-9]{40}', s) and s != '0' * 40, 'expected full lowercase Git commit SHA')
    return s


def _identity(data, repo):
    require(type(data['id']) is int and data['id'] == ENROLLED[repo][0] and data['full_name'] == repo and data['private'] is False
            and data['url'] == f'{ORIGIN}/repos/{repo}', 'GitHub repository identity mismatch')


def _sample(read, repo, sha):
    path = '/repos/' + repo
    raw, more, at = read(f'{path}/commits/{sha}/{QUERY}')
    total, runs = raw['total_count'], raw['check_runs']
    require(type(total) is int and 0 <= total <= 1_000_000 and isinstance(runs, list)
            and len(runs) <= min(total, 50) and (not more or total > len(runs)), 'invalid check run coverage')
    counts = dict(success=0, failure=0, skipped=0, neutral=0, pending=0)
    seen = set()
    for run in runs:
        rid, status, conclusion = run['id'], run['status'], run['conclusion']
        require(type(rid) is int and rid > 0 and rid not in seen and run['head_sha'] == sha
                and run['url'] == f'{ORIGIN}{path}/check-runs/{rid}', 'check run identity mismatch')
        seen.add(rid)
        if status == 'completed':
            if conclusion in ('success', 'neutral', 'skipped'):
                counts[conclusion] += 1
            else:
                require(conclusion in ('failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'),
                        'unknown completed check result')
                counts['failure'] += 1
        else:
            require(status in ('queued', 'in_progress', 'waiting', 'requested', 'pending') and conclusion is None,
                    'invalid incomplete check run')
            counts['pending'] += 1
    return dict(at=at, sha=sha, total=total, sampled=len(runs), truncated=len(runs) < total, **counts)


def _pr(read, repo, number):
    path = f'/repos/{repo}/pulls/{number}'
    p, _, at = read(path)
    require(p['url'] == ORIGIN + path and type(p['number']) is int and p['number'] == number and p['base']['ref'] == 'main',
            'PR identity mismatch')
    _identity(p['base']['repo'], repo)
    _identity(p['head']['repo'], repo)
    head, base = _sha(p['head']['sha']), _sha(p['base']['sha'])
    state = p['state']
    require(type(p['merged']) is bool and type(p['draft']) is bool and state in ('open', 'closed'), 'invalid PR state')
    merged_at = merged_sha = None
    if p['merged']:
        require(state == 'closed' and not p['draft'] and isinstance(p['merged_at'], str) and
                re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z', p['merged_at']),
                'missing completed merge receipt')
        merged_at = _timestamp(datetime.fromisoformat(p['merged_at'].replace('Z', '+00:00')))
        require(merged_at <= at, 'future merge receipt')
        merged_sha = _sha(p['merge_commit_sha'])
        state = 'merged'
    else:
        require(p['merged_at'] is None, 'contradictory merge receipt')
        # GitHub may predict merge_commit_sha for an open PR. Never project it.
    return dict(at=at, number=number, head=head, base=base, state=state, draft=p['draft'], mergedAt=merged_at,
                mergedSha=merged_sha, checks=_sample(read, repo, head))


def collect(include_hive=False):
    started = previous = datetime.now(timezone.utc)

    def stamp():
        nonlocal previous
        now = datetime.now(timezone.utc)
        require(previous <= now and (now - started).total_seconds() <= DEADLINE, 'invalid capture window')
        previous = now
        return _timestamp(now)

    def read(path):
        data, more = _get(path)
        return data, more, stamp()

    repos = []
    for repo, (rid, numbers) in ENROLLED.items():
        path = '/repos/' + repo
        meta, _, at = read(path)
        _identity(meta, repo)
        require(meta['visibility'] == 'public' and meta['default_branch'] == 'main', 'repository outside enrollment')
        ref, _, main_at = read(path + '/git/ref/heads/main')
        sha = _sha(ref['object']['sha'])
        require(ref['ref'] == 'refs/heads/main' and ref['object']['type'] == 'commit'
                and ref['url'] == ORIGIN + path + '/git/refs/heads/main'
                and ref['object']['url'] == ORIGIN + path + '/git/commits/' + sha, 'main commit reference mismatch')
        main = dict(at=main_at, sha=sha, checks=_sample(read, repo, sha))
        prs = [_pr(read, repo, n) for n in numbers if n != 48 or include_hive]
        repos.append(dict(repo=repo, repoId=rid, at=at, main=main, prs=prs))
    return dict(schema='hive-release-read/1', startedAt=_timestamp(started), observedAt=stamp(), repos=repos)


def publish(directory, include_hive=False):
    # Open the selected directory once; use that fd for all subsequent operations.
    dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        ds = os.fstat(dfd)
        require(ds.st_uid == os.geteuid() and stat.S_IMODE(ds.st_mode) == 0o700, 'expected private staging directory (0700)')
        value = collect(include_hive)
        raw = (json.dumps(value, allow_nan=False, indent=2) + '\n').encode('ascii')
        require(len(raw) <= MAX_OUTPUT, 'projection exceeds byte limit')
        name = '.release-' + secrets.token_hex(16)
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, 'release.json', src_dir_fd=dfd, dst_dir_fd=dfd)
            os.fsync(dfd)
        finally:
            try:
                os.unlink(name, dir_fd=dfd)
            except FileNotFoundError:
                pass
        return value['observedAt']
    finally:
        os.close(dfd)


def main():
    cli = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    cli.add_argument('--staging-dir', required=True, help='existing owner-only staging directory (0700)')
    cli.add_argument('--include-hive', action='store_true', help='also observe Orbit Hive PR #48')
    args = cli.parse_args()

    def deadline(*_):
        raise TimeoutError('capture deadline exceeded')

    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(DEADLINE)
    try:
        at = publish(args.staging_dir, args.include_hive)
    except (ValueError, KeyError, OSError, TypeError, RecursionError, http.client.HTTPException) as e:
        # No API payload, local path or caller-provided value in diagnostics.
        reason = str(e) if type(e) is ValueError and str(e).startswith('GitHub HTTP ') else type(e).__name__
        cli.exit(1, f'Release read refused: {reason}.\n')
    finally:
        signal.alarm(0)
    print(f'Published release.json through {at}.')


if __name__ == '__main__':
    main()
