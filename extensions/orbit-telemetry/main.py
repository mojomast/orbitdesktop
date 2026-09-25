"""Owner-authenticated, read-only telemetry service, separate from Orbit terminals."""
import json
import os
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from metrics import HostSampler, TokenRates, gateway, USAGE
from activity import Activity

ORIGIN = 'https://kimi.tailec998.ts.net:4365'
OWNER = 'mojomasta@gmail.com'
LOCK = threading.Lock()
STATE = {}


def collect():
    host, rates = HostSampler(), TokenRates()
    activity = Activity()
    last_gateway = 0
    while True:
        start = time.monotonic()
        result = {}
        try:
            result['host'] = host.sample()
        except Exception:
            result['host'] = {'error': 'Host sample unavailable'}
        try:
            usage = json.loads(USAGE.read_text())
            result['usage'], result['rates'] = usage, rates.sample(usage)
        except Exception:
            result['usage'] = {'error': 'Saved token counters unavailable'}
        if start - last_gateway >= 5:
            try:
                result['opencode_activity'] = activity.sample()
            except Exception:
                result['opencode_activity'] = {'available': False, 'updated_at': time.time()}
            try:
                result['gateway'] = gateway()
            except Exception:
                result['gateway'] = {'available': False, 'updated_at': time.time()}
            last_gateway = start
        result['updated_at'] = time.time()
        with LOCK:
            STATE.update(result)
        time.sleep(max(.1, 2 - (time.monotonic() - start)))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, data, kind='application/json'):
        raw = json.dumps(data).encode() if kind == 'application/json' else data
        self.send_response(code)
        for k, v in {'Content-Type': kind, 'Content-Length': str(len(raw)), 'Cache-Control': 'no-store',
                     'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
                     'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://kimi.tailec998.ts.net:4325"}.items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/health':
            return self.reply(200, {'ok': True, 'release': os.environ.get('ORBIT_EXTENSION_RELEASE', 'test')})
        if self.headers.get('Host') not in ('kimi.tailec998.ts.net:4365', '127.0.0.1:' + str(self.server.server_port)) or self.headers.get('Tailscale-User-Login') != OWNER:
            return self.reply(403, {'error': 'Owner tailnet authentication required'})
        if self.headers.get('Origin') not in (None, ORIGIN):
            return self.reply(403, {'error': 'Cross-origin requests are not allowed'})
        if path == '/api/metrics':
            with LOCK:
                data = dict(STATE)
            return self.reply(200, data)
        files = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
        if path in files:
            file, kind = files[path]
            return self.reply(200, (Path(__file__).parent / file).read_bytes(), kind)
        self.reply(404, {'error': 'Not found'})


if __name__ == '__main__':
    os.umask(0o077)
    threading.Thread(target=collect, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', int(os.environ['ORBIT_EXTENSION_PORT'])), Handler).serve_forever()
