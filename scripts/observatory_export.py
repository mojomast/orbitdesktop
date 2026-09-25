"""Read-only, allowlisted numeric telemetry. Never export IDs, names, prompts or secrets.

The aggregate feed is app-server accessible, like the existing token widget feed.
Private diagnostic detail belongs in authenticated Hermes tools, not this feed.
"""
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT.parent.parent
WORKSPACE = 'eed047a8-e519-495e-a7ca-1c8c150a6ef4'
OUTPUT = ROOT / '.runtime/apps/orbit-observatory-data/snapshot.json'
PRIVATE = ROOT / '.runtime/observatory-previous.json'


def epoch(value):
    if isinstance(value, (float, int)):
        return value
    if isinstance(value, str):
        try:
            return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
        except ValueError:
            pass
    return None


def host(previous, now):
    cpu = [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    total, idle = sum(cpu), cpu[3] + cpu[4]
    old = previous.get('_counters', {})
    elapsed = now - previous.get('updated_at', now)
    delta = total - old.get('cpu_total', total)
    usage = max(0, min(100, 100 * (1 - (idle - old.get('cpu_idle', idle)) / delta))) if delta > 0 else None
    mem = {line.split(':')[0]: int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()}
    net = [line.split(':', 1)[1].split() for line in Path('/proc/net/dev').read_text().splitlines()[2:] if line.split(':', 1)[0].strip() != 'lo']
    rx, tx = sum(int(x[0]) for x in net), sum(int(x[8]) for x in net)
    def rate(key, value):
        return max(0, (value - old[key]) / elapsed) if key in old and 0 < elapsed < 120 else None
    disk = shutil.disk_usage(ROOT)
    pressure = {}
    for name in ('cpu', 'memory', 'io'):
        try:
            fields = Path('/proc/pressure/' + name).read_text().splitlines()[0].split()[1:]
            pressure[name] = float(dict(x.split('=') for x in fields)['avg10'])
        except (OSError, KeyError, ValueError):
            pressure[name] = None
    result = {'cpu_percent': usage, 'cores': os.cpu_count(), 'load': list(os.getloadavg()),
              'memory_used': mem['MemTotal'] - mem['MemAvailable'], 'memory_total': mem['MemTotal'],
              'swap_used': mem['SwapTotal'] - mem['SwapFree'], 'swap_total': mem['SwapTotal'],
              'disk_used': disk.used, 'disk_total': disk.total, 'disk_free': disk.free,
              'rx_per_second': rate('rx', rx), 'tx_per_second': rate('tx', tx),
              'uptime_seconds': float(Path('/proc/uptime').read_text().split()[0]), 'pressure': pressure}
    return result, {'cpu_total': total, 'cpu_idle': idle, 'rx': rx, 'tx': tx}


def usage():
    fields = 'count(*) sessions, coalesce(sum(input_tokens),0) input, coalesce(sum(output_tokens),0) output, coalesce(sum(cache_read_tokens),0) cached, coalesce(sum(reasoning_tokens),0) reasoning, coalesce(sum(api_call_count),0) calls, coalesce(sum(tool_call_count),0) tools, coalesce(sum(message_count),0) messages'
    with sqlite3.connect(f'file:{PROFILE / "state.db"}?mode=ro', uri=True, timeout=3) as db:
        db.row_factory = sqlite3.Row
        return {name: dict(db.execute(f'SELECT {fields} FROM sessions {where}').fetchone()) for name, where in (
            ('orbit', "WHERE id LIKE 'orbit-%'"), ('profile', ''),
            ('recent', f'WHERE started_at >= {time.time() - 86400}'))}


def jobs(now):
    data = json.loads((PROFILE / 'cron/jobs.json').read_text())
    rows = data.get('jobs', []) if isinstance(data, dict) else data
    enabled = [j for j in rows if j.get('enabled')]
    next_runs = [epoch(j.get('next_run_at')) for j in enabled]
    next_runs = [x for x in next_runs if x is not None]
    return {'total': len(rows), 'enabled': len(enabled), 'disabled': len(rows) - len(enabled),
            'failing': sum(bool(j.get('failure_streak') or j.get('last_error') or j.get('last_delivery_error')) for j in rows),
            'overdue': sum(x < now - 300 for x in next_runs), 'next_run_at': min(next_runs, default=None)}


def workspace(now):
    r = json.loads((ROOT / '.runtime/workspaces' / (WORKSPACE + '.json')).read_text())
    state = r['state']
    def panes(layout):
        return 1 if layout['type'] == 'pane' else panes(layout['first']) + panes(layout['second'])
    return {'revision': r['revision'], 'observed_revision': r.get('observed_revision', 0),
            'browser_age_seconds': max(0, now - r['browser_seen'] / 1000) if r.get('browser_seen') else None,
            'windows': len(state['monitors']), 'panes': sum(panes(m['layout']) for m in state['monitors']),
            'plugins': len(state.get('plugins', [])), 'enabled_plugins': sum(bool(p.get('enabled')) for p in state.get('plugins', []))}


def service():
    status = subprocess.run(['systemctl', '--user', 'is-active', 'orbitdesktop-plugins.service'], capture_output=True, text=True, timeout=4)
    record = json.loads((ROOT / '.runtime/workspaces' / (WORKSPACE + '.json')).read_text())
    start = time.monotonic()
    try:
        with urllib.request.urlopen(record['api'] + '/api/health', timeout=4) as response:
            ok = response.status == 200
        latency = (time.monotonic() - start) * 1000
    except Exception:
        ok, latency = False, None
    return {'orbit_active': status.stdout.strip() == 'active', 'http_ok': ok, 'http_latency_ms': latency}


def collect(previous=None):
    previous = previous or {}
    now = time.time()
    result = {'version': 1, 'updated_at': now, 'interval_seconds': 10, 'sources': {}}
    counters = {}
    for name, collect_source in [('host', lambda: host(previous, now)), ('usage', usage), ('jobs', lambda: jobs(now)), ('workspace', lambda: workspace(now)), ('service', service)]:
        try:
            value = collect_source()
            if name == 'host':
                value, counters = value
            result[name] = value
            result['sources'][name] = 'ok'
        except Exception:
            result[name] = None
            result['sources'][name] = 'unavailable'
    point = {'at': now, 'cpu': (result['host'] or {}).get('cpu_percent'),
             'memory': (result['host'] or {}).get('memory_used'), 'rx': (result['host'] or {}).get('rx_per_second'),
             'latency': (result['service'] or {}).get('http_latency_ms')}
    result['history'] = [x for x in previous.get('history', []) if now - 3600 < x.get('at', 0) < now][-359:] + [point]
    return result, counters


def main():
    try:
        previous = json.loads(PRIVATE.read_text())
    except (OSError, ValueError):
        previous = {}
    result, counters = collect(previous)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    # Preserve timestamps so the app watcher does not reload other iframes every sample.
    stat = OUTPUT.parent.stat()
    tmp = OUTPUT.with_name('.snapshot.tmp')
    tmp.write_text(json.dumps(result, allow_nan=False))
    os.utime(tmp, (stat.st_mtime, stat.st_mtime))
    tmp.replace(OUTPUT)
    os.utime(OUTPUT.parent, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    private_tmp = PRIVATE.with_suffix('.tmp')
    private_tmp.write_text(json.dumps({**result, '_counters': counters}, allow_nan=False))
    private_tmp.chmod(0o600)
    private_tmp.replace(PRIVATE)
    print(json.dumps({'sources': result['sources'], 'history_samples': len(result['history'])}))


if __name__ == '__main__':
    main()
