"""Private, owner-authenticated Hermes catalog browser. Standard-library service.
No shell input, arbitrary URLs, or commands accepted from the browser.
"""
import http.cookies
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get('ORBIT_CATALOG_CONFIG', next((p / 'plugin-catalog/config.json' for p in ROOT.parents if p.name == '.runtime'), Path.home() / '.config/orbit-plugin-catalog/config.json')))
CATALOG_URL = 'https://hermes-agent.nousresearch.com/docs/api/plugin-catalog.json'
NAME = re.compile(r'[a-zA-Z0-9_-]{1,64}\Z')
SHA = re.compile(r'[a-fA-F0-9]{40}\Z')
CONFIG = {}
CATALOG = None
CATALOG_TIME = 0
CATALOG_LOCK = threading.Lock()
OP_LOCK = threading.Lock()
SESSIONS = {}
JOBS = {}
JOB_LOCK = threading.Lock()
LOGIN_LOCK = threading.Lock()
LOGIN_TIMES = []
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def fetch_json(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with OPENER.open(req, timeout=25) as response:
        raw = response.read(5_000_001)
    if len(raw) > 5_000_000:
        raise ValueError('Remote response too large')
    return json.loads(raw)


def validate_catalog(data):
    if not isinstance(data, dict) or not isinstance(data.get('entries'), list) or not isinstance(data.get('removed'), list):
        raise ValueError('Invalid catalog response; installation blocked')
    names = set()
    for e in data['entries']:
        if not isinstance(e, dict) or not NAME.fullmatch(str(e.get('name', ''))) or not SHA.fullmatch(str(e.get('sha', ''))):
            raise ValueError('Invalid catalog name or SHA')
        u = urlsplit(e.get('repo', ''))
        if u.scheme != 'https' or u.username or u.password or u.query or u.fragment or not u.hostname or not re.fullmatch(r'[A-Za-z0-9.-]+', u.netloc) or not re.fullmatch(r'/[A-Za-z0-9._~/-]+', u.path):
            raise ValueError('Invalid repository URL')
        subdir = e.get('subdir', '')
        if not isinstance(subdir, str) or (subdir and not re.fullmatch(r'[A-Za-z0-9._/-]+', subdir)) or subdir.startswith('/') or '\\' in subdir or any(p in ('.', '..') for p in subdir.split('/')):
            raise ValueError('Invalid plugin subdirectory')
        if e['name'] in names:
            raise ValueError('Duplicate catalog name')
        names.add(e['name'])
    return data


def catalog(force=False):
    global CATALOG, CATALOG_TIME
    with CATALOG_LOCK:
        if not force and CATALOG is not None and time.time() - CATALOG_TIME < 900:
            return dict(CATALOG, fetched_at=CATALOG_TIME)
        data = validate_catalog(fetch_json(CATALOG_URL))
        CATALOG, CATALOG_TIME = data, time.time()
        return dict(data, fetched_at=CATALOG_TIME)


def canonical(repo):
    return repo.split('#', 1)[0].rstrip('/').removesuffix('.git').lower()


def entry_for(data, name, sha):
    entry = next((e for e in data['entries'] if e['name'] == name), None)
    if not entry or entry['sha'] != sha:
        raise ValueError('Catalog entry changed or was delisted. Refresh and review again.')
    for item in data['removed']:
        if isinstance(item, str):
            blocked = item == name
        elif isinstance(item, dict):
            blocked = item.get('name') == name or (item.get('repo') and canonical(item['repo']) == canonical(entry['repo']))
        else:
            raise ValueError('Invalid removed list; installation blocked')
        if blocked:
            raise ValueError('Plugin is on the catalog removal list')
    platforms = entry.get('platforms') or []
    if platforms and 'linux' not in platforms:
        raise ValueError('This plugin does not declare Linux support')
    return entry


def run_bridge(args, timeout=180):
    env = {'PATH': str(Path.home() / '.local/bin') + ':/usr/local/bin:/usr/bin:/bin',
           'HOME': str(Path.home()), 'HERMES_HOME': CONFIG['hermes_home'],
           'NO_COLOR': '1', 'TERM': 'dumb', 'GIT_TERMINAL_PROMPT': '0',
           'PYTHONDONTWRITEBYTECODE': '1'}
    proc = subprocess.Popen([CONFIG['hermes_python'], str(ROOT / 'bridge.py'), *args],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=env, start_new_session=True)
    # Drain incrementally, keeping a bounded tail (not an unbounded communicate buffer).
    tail = bytearray()
    def drain():
        while True:
            part = proc.stdout.read(4096)
            if not part:
                break
            tail.extend(part)
            if len(tail) > 60000:
                del tail[:-60000]
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        reader.join(timeout=3)
        raise ValueError('Hermes operation timed out. Check installed state before retrying.')
    reader.join(timeout=3)
    output = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', tail.decode(errors='replace'))
    # No config, environment values, or arbitrary command input is sent to the client.
    output = re.sub(r'(https?://)[^\s/@]+:[^\s/@]+@', r'\1[redacted]@', output)
    return proc.returncode, output


def installed():
    code, output = run_bridge(['metadata'], timeout=30)
    if code:
        raise ValueError('Cannot read installed plugin metadata; verify Hermes compatibility.')
    return json.loads(output)


def match_installed(entry, rows):
    for row in rows:
        source, _, subdir = str(row.get('source', '')).partition('#')
        if canonical(source) == canonical(entry['repo']) and subdir == entry.get('subdir', ''):
            return row
    return None


def execute_job(job_id, entry, action):
    job = JOBS[job_id]
    try:
        # Refresh again at execution time. No stale/offline installs.
        entry = entry_for(catalog(force=True), entry['name'], entry['sha'])
        if action != 'disable':
            code, message = run_bridge(['compatible', entry.get('requires_hermes', '')], timeout=30)
            if code:
                raise ValueError(message.strip())
        rows = installed()
        current = match_installed(entry, rows)
        if action == 'install':
            if current:
                raise ValueError('Already installed. No destructive force reinstall is offered here.')
            identifier = entry['repo'] + ('#' + entry['subdir'] if entry.get('subdir') else '')
            code, log = run_bridge(['install', identifier, entry['sha']])
        else:
            if not current or not NAME.fullmatch(current['name']):
                raise ValueError('Plugin is not installed from this catalog repository')
            if action == 'enable' and current.get('revision') != entry['sha']:
                raise ValueError('Installed SHA differs from the reviewed pin; enable blocked.')
            code, log = run_bridge([action, current['name']])
        after = match_installed(entry, installed())
        ok = code == 0 and after is not None
        if action == 'install':
            ok = ok and after.get('revision') == entry['sha'] and after.get('status') == 'disabled'
        else:
            ok = ok and after.get('status') == ('enabled' if action == 'enable' else 'disabled')
        job.update(status='succeeded' if ok else 'failed', log=log[-30000:], installed=after,
                   message=('Installed at the reviewed SHA, disabled. Review dependencies and configuration before enabling.' if action == 'install' else 'Saved. Start a new Hermes session to load the change.') if ok else 'Hermes did not complete the operation. Review the output; scanner warnings are not auto-approved.')
    except Exception as exc:
        job.update(status='failed', message=str(exc), log=job.get('log', ''))
    finally:
        job['finished_at'] = time.time()
        OP_LOCK.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log credentials, request bodies or query strings.

    def send(self, status, data, content_type='application/json', cookie=None):
        raw = json.dumps(data).encode() if content_type == 'application/json' else data
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors " + CONFIG['orbit_origin'])
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(raw)

    def valid_host(self):
        allowed = {urlsplit(CONFIG['public_origin']).netloc, f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        return self.headers.get('Host') in allowed

    def session(self):
        key = self.headers.get('Authorization', '').removeprefix('Bearer ')
        s = SESSIONS.get(key)
        return s if s and s['expires'] > time.time() else None

    def do_GET(self):
        if not self.valid_host():
            return self.send(403, {'error': 'Host rejected'})
        try:
            path = urlsplit(self.path).path
            if path == '/health':
                return self.send(200, {'ok': True, 'release': os.environ.get('ORBIT_EXTENSION_RELEASE', 'dev')})
            if path in ('/', '/app.js', '/style.css'):
                filename = 'index.html' if path == '/' else path[1:]
                mime = {'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8'}[filename]
                return self.send(200, (ROOT / filename).read_bytes(), mime)
            if path == '/api/catalog':
                return self.send(200, catalog())
            s = self.session()
            if path == '/api/session':
                return self.send(200, {'unlocked': bool(s), 'csrf': s['csrf'] if s else None, 'profile': CONFIG.get('profile_label', 'Configured Hermes profile')})
            if not s:
                return self.send(401, {'error': 'Unlock with your Orbit host token to manage plugins.'})
            if path == '/api/installed':
                return self.send(200, {'plugins': installed()})
            if path == '/api/jobs':
                return self.send(200, {'jobs': list(JOBS.values())[-30:]})
            return self.send(404, {'error': 'Not found'})
        except Exception as exc:
            return self.send(502, {'error': str(exc)})

    def do_POST(self):
        if not self.valid_host() or self.headers.get('Origin') != CONFIG['public_origin']:
            return self.send(403, {'error': 'Origin rejected'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.send(415, {'error': 'JSON required'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size < 8192:
                raise ValueError('Invalid request size')
            data = json.loads(self.rfile.read(size))
            path = urlsplit(self.path).path
            if path == '/api/unlock':
                with LOGIN_LOCK:
                    LOGIN_TIMES[:] = [t for t in LOGIN_TIMES if time.time() - t < 60]
                    if len(LOGIN_TIMES) >= 10:
                        return self.send(429, {'error': 'Too many unlock attempts. Wait one minute.'})
                    LOGIN_TIMES.append(time.time())
                token = data.get('token')
                if not isinstance(token, str) or not 32 <= len(token) <= 512:
                    return self.send(401, {'error': 'Invalid host token'})
                try:
                    check = fetch_json(CONFIG['orbit_auth_url'], json.dumps({'token': token}).encode(), {'Content-Type': 'application/json', 'Origin': CONFIG['orbit_origin']})
                    if check.get('ok') is not True:
                        raise ValueError()
                except Exception:
                    return self.send(401, {'error': 'Host unlock failed'})
                for key in list(SESSIONS):
                    if SESSIONS[key]['expires'] < time.time():
                        del SESSIONS[key]
                key = secrets.token_urlsafe(32)
                s = {'csrf': secrets.token_urlsafe(32), 'expires': time.time() + 3600}
                SESSIONS[key] = s
                return self.send(200, {'ok': True, 'csrf': s['csrf'], 'session_token': key})
            s = self.session()
            if not s or not secrets.compare_digest(str(data.get('csrf', '')), s['csrf']):
                return self.send(403, {'error': 'Unlock required or expired session'})
            if path == '/api/lock':
                s['expires'] = 0
                return self.send(200, {'ok': True}, cookie='orbit_catalog=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
            if path == '/api/refresh':
                return self.send(200, catalog(force=True))
            if path != '/api/action':
                return self.send(404, {'error': 'Not found'})
            action = data.get('action')
            if action not in ('install', 'enable', 'disable') or data.get('confirm') is not True:
                raise ValueError('Explicit confirmation and a supported action are required')
            entry = entry_for(catalog(), data.get('name'), data.get('sha'))
            if not OP_LOCK.acquire(blocking=False):
                return self.send(409, {'error': 'Another operation is running. Wait for its result.'})
            key = secrets.token_hex(12)
            with JOB_LOCK:
                while len(JOBS) >= 30:
                    del JOBS[next(iter(JOBS))]
                JOBS[key] = {'id': key, 'name': entry['name'], 'action': action, 'status': 'running', 'started_at': time.time(), 'log': ''}
            threading.Thread(target=execute_job, args=(key, entry, action), daemon=True).start()
            return self.send(202, {'job': JOBS[key]})
        except (ValueError, TypeError, KeyError) as exc:
            return self.send(400, {'error': str(exc)})
        except Exception:
            return self.send(500, {'error': 'Operation failed; check local service diagnostics'})


if __name__ == '__main__':
    CONFIG = json.loads(CONFIG_PATH.read_text())
    ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('ORBIT_EXTENSION_PORT', '4420'))), Handler).serve_forever()
