"""Read-only Linux telemetry. Never read process arguments, environment or transcripts."""
import json
import os
from pathlib import Path
import time
import urllib.request
from collections import deque

ROOT = Path('/home/mojo/.hermes-instances/fresh/workspace/orbitdesktop')
USAGE = ROOT / '.runtime/apps/hermes-token-stats/usage.json'


def cpu_percent(current, previous):
    if previous is None:
        return None
    total = current[0] - previous[0]
    idle = current[1] - previous[1]
    if total <= 0 or idle < 0:
        return None
    return round(max(0, min(100, 100 * (total - idle) / total)), 1)


def process_stat(raw, page_size):
    end = raw.rfind(')')
    name = raw[raw.index('(') + 1:end][:64]
    fields = raw[end + 2:].split()  # starts with field 3 (state)
    return {'name': name, 'ticks': int(fields[11]) + int(fields[12]),
            'start': int(fields[19]), 'rss': max(0, int(fields[21])) * page_size}


class HostSampler:
    def __init__(self):
        self.previous_cpu = {}
        self.previous_processes = {}
        self.previous_time = None

    def sample(self):
        now = time.monotonic()
        elapsed = now - self.previous_time if self.previous_time is not None else None
        counters = {}
        for line in Path('/proc/stat').read_text().splitlines():
            fields = line.split()
            if fields and (fields[0] == 'cpu' or fields[0][3:].isdigit() and fields[0].startswith('cpu')):
                values = [int(v) for v in fields[1:9]]  # guest already included in user/nice
                counters[fields[0]] = (sum(values), values[3] + values[4])
        usage = {k: cpu_percent(v, self.previous_cpu.get(k)) for k, v in counters.items()}
        mem = {line.split(':')[0]: int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()}
        processes, skipped = {}, 0
        ticks = os.sysconf('SC_CLK_TCK')
        page_size = os.sysconf('SC_PAGE_SIZE')
        rows = []
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                p = process_stat((path / 'stat').read_text(), page_size)
                processes[path.name] = p
                previous = self.previous_processes.get(path.name)
                percent = None
                if elapsed and previous and p['start'] == previous['start']:
                    percent = round(max(0, p['ticks'] - previous['ticks']) / ticks / elapsed * 100, 1)
                if p['rss']:
                    rows.append({'name': p['name'], 'pid': int(path.name), 'cpu_percent': percent, 'rss': p['rss']})
            except (OSError, ValueError, IndexError):
                skipped += 1
        apps = {}
        for row in rows:
            app = apps.setdefault(row['name'], {'name': row['name'], 'count': 0, 'cpu_percent': None, 'rss': 0})
            app['count'] += 1
            app['rss'] += row['rss']
            if row['cpu_percent'] is not None:
                app['cpu_percent'] = round((app['cpu_percent'] or 0) + row['cpu_percent'], 1)
        self.previous_cpu, self.previous_processes, self.previous_time = counters, processes, now
        return {'updated_at': time.time(), 'cpu_percent': usage.get('cpu'),
                'cores': [{'id': k[3:], 'percent': v} for k, v in usage.items() if k != 'cpu'],
                'memory_total': mem['MemTotal'], 'memory_used': mem['MemTotal'] - mem['MemAvailable'],
                'memory_available': mem['MemAvailable'], 'swap_total': mem['SwapTotal'],
                'swap_used': mem['SwapTotal'] - mem['SwapFree'], 'load': list(os.getloadavg()),
                'process_count': len(processes), 'unreadable_processes': skipped,
                'top_apps_cpu': sorted(apps.values(), key=lambda p: p['cpu_percent'] or 0, reverse=True)[:8],
                'top_apps_memory': sorted(apps.values(), key=lambda p: p['rss'], reverse=True)[:8],
                'top_cpu': sorted(rows, key=lambda p: p['cpu_percent'] or 0, reverse=True)[:8],
                'top_memory': sorted(rows, key=lambda p: p['rss'], reverse=True)[:8]}


class TokenRates:
    def __init__(self):
        self.samples = deque(maxlen=30)

    def sample(self, usage):
        stamp = usage.get('updated_at', 0)
        if not self.samples or stamp > self.samples[-1]['updated_at']:
            self.samples.append(usage)
        while len(self.samples) > 2 and stamp - self.samples[0]['updated_at'] > 65:
            self.samples.popleft()
        first = self.samples[0]
        elapsed = stamp - first['updated_at']
        rates = {}
        for scope in ('profile', 'orbit', 'opencode'):
            current, old = usage.get(scope, {}), first.get(scope, {})
            values = {}
            for key in ('input', 'output', 'calls'):
                valid = elapsed > 0 and key in current and key in old and current[key] >= old[key]
                values[key + '_per_second'] = round((current[key] - old[key]) / elapsed, 2) if valid else None
            rates[scope] = values
        return {'window_seconds': round(elapsed, 1), 'updated_at': stamp, 'scopes': rates}


def gateway():
    # Existing server configuration is read privately; credentials never leave this process.
    env = dict(line.split('=', 1) for line in (ROOT / '.env.deploy').read_text().splitlines()
               if '=' in line and not line.startswith('#'))
    req = urllib.request.Request(env['HERMES_API_URL'].rstrip('/') + '/health/detailed',
                                 headers={'Authorization': 'Bearer ' + env['HERMES_API_KEY']})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=3) as response:
        data = json.load(response)
    queue = data.get('readiness', {}).get('checks', {}).get('background_queues', {})
    active = queue.get('active_api_runs')
    return {'updated_at': time.time(), 'available': isinstance(active, int),
            'in_flight': active if isinstance(active, int) else None,
            'delegations': queue.get('active_delegations'), 'status': data.get('status', 'unknown')}
