"""Portable, read-only Linux host telemetry. Trusted owner code, not a sandbox."""
import json
import os
from pathlib import Path
import pwd
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG = Path(pwd.getpwuid(os.getuid()).pw_dir) / '.config/orbit/live-telemetry.json'
RELEASE = os.environ.get('ORBIT_EXTENSION_RELEASE', 'development')


def sample(previous=None):
    ticks = [int(v) for v in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    total, idle = sum(ticks), ticks[3] + ticks[4]
    cpu = None
    if previous and total > previous[0]:
        cpu = max(0, min(100, 100 * (1 - (idle - previous[1]) / (total - previous[0]))))
    memory = {line.split(':')[0]: int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()}
    return {'sampledAt': time.time(), 'cpuPercent': cpu, 'memoryUsed': memory['MemTotal'] - memory['MemAvailable'], 'memoryTotal': memory['MemTotal'], 'load': list(os.getloadavg()), 'logicalCpus': os.cpu_count()}, (total, idle)


def handler(config):
    expected_host = config['host']
    owner = config['owner']
    orbit_origin = config['orbitOrigin']
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == '/health':
                return self.reply(200, {'ok': True, 'release': RELEASE})
            if (self.headers.get('Host') != expected_host or self.headers.get('Tailscale-User-Login') != owner or self.headers.get('Origin') not in (None, 'https://' + expected_host)):
                return self.reply(403, {'error': 'Owner-authenticated private proxy required'})
            if self.path == '/api/metrics':
                with self.server.metrics_lock:
                    data = dict(self.server.metrics)
                return self.reply(200, data)
            if self.path in ('/', '/app.js', '/style.css'):
                name = 'index.html' if self.path == '/' else self.path[1:]
                body = (Path(__file__).parent / name).read_bytes()
                return self.reply(200, body, {'index.html': 'text/html', 'app.js': 'text/javascript', 'style.css': 'text/css'}[name])
            self.reply(404, {'error': 'Not found'})

        def reply(self, code, data, content_type='application/json'):
            body = json.dumps(data).encode() if isinstance(data, dict) else data
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors " + orbit_origin + "; object-src 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)
    return Handler


def validate_config(config):
    from urllib.parse import urlsplit
    import re
    if set(config) != {'host', 'owner', 'orbitOrigin'}:
        raise ValueError('Expected host, owner, orbitOrigin')
    for value in config.values():
        if not isinstance(value, str) or not value or any(c.isspace() for c in value):
            raise ValueError('Invalid configuration')
    if not re.fullmatch(r'[A-Za-z0-9.-]+(?::[0-9]{1,5})?', config['host']) or not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?', config['orbitOrigin']):
        raise ValueError('Expected a DNS host and HTTPS origin')
    origin = urlsplit(config['orbitOrigin'])
    if origin.scheme != 'https' or not origin.hostname or origin.path or origin.query or origin.fragment or origin.username or origin.password:
        raise ValueError('Orbit origin must be an HTTPS origin')
    host = urlsplit('https://' + config['host'])
    if not host.hostname or host.path or host.query or host.fragment or host.username or host.password:
        raise ValueError('Invalid host')
    return config


def main():
    config = validate_config(json.loads(CONFIG.read_text()))
    server = ThreadingHTTPServer(('127.0.0.1', int(os.environ['ORBIT_EXTENSION_PORT'])), handler(config))
    server.metrics_lock = threading.Lock()
    server.metrics, initial = sample()
    def sampler():
        previous = initial
        while True:
            time.sleep(2)
            try:
                data, previous = sample(previous)
            except (OSError, ValueError, KeyError):
                data = {'error': 'Host metrics unavailable', 'sampledAt': time.time()}
            with server.metrics_lock:
                server.metrics = data
    threading.Thread(target=sampler, daemon=True).start()
    server.serve_forever()


if __name__ == '__main__':
    main()
