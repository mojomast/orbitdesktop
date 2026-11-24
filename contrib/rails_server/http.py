"""Bounded loopback HTTP reader. No writer, adapter, upstream URL or body parser."""
from contextlib import contextmanager
import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import stat
import sys
import threading
import time
from urllib.parse import parse_qsl
from uuid import UUID

from . import stream

CONTRIB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CONTRIB))  # Only the sibling, offline-vendored package.
from rizzstack_rails import RailsLedger
from rizzstack_rails.export import feedback_csv
from rizzstack_rails.query import QueryError, make_request, query_events, query_view_page
from rizzstack_rails.projection import public_id


CONTRACT_DIGEST = 'a82b9489a78e7b578ac6f43fe7a66d383e7ee4be437725db42a1eaa362e48bc6'
HTTP_LIMIT = 128 * 1024
PAGE_FIELDS = {'kind', 'id', 'format', 'limit', 'after', 'max_bytes', 'include', 'show_tokens'}
STATUSES = {'invalid_request': 400, 'auth_required': 401, 'forbidden': 403,
            'not_found': 404, 'reset_required': 409, 'conflict': 409, 'source_fork': 409,
            'too_large': 413, 'capacity': 429, 'source_unavailable': 503, 'storage_full': 503}


class Refusal(Exception):
    def __init__(self, code):
        self.code = code


def wire(obj):
    return json.dumps(obj, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def error_body(code):
    return wire({'ok': False, 'error': {'code': code, 'retryable': STATUSES[code] in (429, 503),
                                        'request_id': secrets.token_hex(12)}})


def credential(path):
    # O_NONBLOCK avoids hanging on an accidentally configured FIFO. Keep one fd
    # across fstat/read so rotation is atomic from the caller's perspective.
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), 'rb') as f:
            info = os.fstat(f.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                return None
            val = f.read(515).removesuffix(b'\n').removesuffix(b'\r')
            if re.fullmatch(rb'[A-Za-z0-9._~+/=-]{16,512}', val):
                return b'Bearer ' + val
    except OSError:
        pass
    return None


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 24
    poll_interval = 1.0
    stream_ttl = 300.0

    def __init__(self, addr, ledger_path, credential_file):
        ip = ipaddress.ip_address(addr[0])
        if not ip.is_loopback or '%' in addr[0]:
            raise ValueError('numeric loopback required')
        self.address_family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
        self.db = Path(ledger_path)
        self.credential_file = Path(credential_file)
        if not self.db.is_absolute() or not self.credential_file.is_absolute():
            raise ValueError('absolute configuration paths required')
        if credential(self.credential_file) is None:
            raise ValueError('read credential unavailable')
        manifest = (CONTRIB / 'rizzstack_rails/vendor-manifest.json').read_bytes()
        self.runtime_digest = hashlib.sha256(manifest).hexdigest()
        self.runtime_revision = json.loads(manifest)['pin_label']
        if not re.fullmatch(r'[0-9a-f]{40}|unreviewed-working-tree', self.runtime_revision):
            raise ValueError('unknown vendor revision')
        self.connections = threading.BoundedSemaphore(24)
        self.streams = threading.BoundedSemaphore(8)
        self.pages = threading.BoundedSemaphore(4)
        self.stopping = threading.Event()
        super().__init__(addr, Handler)
        host = ip.compressed if ip.version == 4 else '[' + ip.compressed + ']'
        self.expected_host = f'{host}:{self.server_port}'

    def server_bind(self):
        # HTTPServer.server_bind normally performs an unnecessary reverse lookup.
        from socketserver import TCPServer
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def process_request(self, sock, addr):
        if not self.connections.acquire(False):
            try:
                sock.setblocking(False)
                data = error_body('capacity')
                sock.sendall(b'HTTP/1.0 429 Too Many Requests\r\nConnection: close\r\nCache-Control: no-store\r\n'
                             b'Content-Type: application/json\r\nContent-Length: %d\r\n\r\n' % len(data) + data)
            except OSError:
                pass
            finally:
                self.shutdown_request(sock)
            return
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 64 * 1024)
            super().process_request(sock, addr)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()

    def handle_error(self, request, client_address):
        pass  # No stdlib traceback, arbitrary URL, peer or headers in logs.

    def shutdown(self):
        self.stopping.set()
        super().shutdown()

    @contextmanager
    def reader(self):
        if not self.db.is_file():
            raise Refusal('source_unavailable')
        # Do not treat a removed/replaced DB's surviving WAL as the database.
        # Open read-only; even an invalid main file must not be initialized.
        with self.db.open('rb') as main:
            header = main.read(20)
            if len(header) != 20 or header[:16] != b'SQLite format 3\x00':
                raise Refusal('source_unavailable')
            if 2 in header[18:20] and not all(Path(str(self.db) + suffix).is_file()
                                               for suffix in ('-shm', '-wal')):
                raise Refusal('source_unavailable')
        ledger = RailsLedger(self.db, read_only=True)
        try:
            if str(UUID(ledger.ledger_uuid)) != ledger.ledger_uuid:
                raise Refusal('source_unavailable')
            db = ledger._conn  # R02 reader's existing mode=ro, query_only connection
            db.execute('PRAGMA trusted_schema=OFF')
            db.execute('PRAGMA busy_timeout=1000')
            db.execute('PRAGMA temp_store=MEMORY')  # no scratch files for read-side sorts
            db.execute('PRAGMA cache_size=-2048')
            if hasattr(db, 'setlimit'):
                db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 1024 * 1024)
            deadline = time.monotonic() + 3
            db.set_progress_handler(lambda: time.monotonic() > deadline, 1000)
            db.execute('BEGIN')  # Short read snapshot. No connection held across SSE writes or waits.
            yield ledger
        finally:
            ledger.close()


def make_server(host, port, ledger_path, credential_file):
    return Server((host, port), ledger_path, credential_file)


class HeaderBudget:
    def __init__(self, reader):
        self.reader = reader
        self.remain = 16384

    def readline(self, size=-1):
        line = self.reader.readline(min(size, self.remain + 1))
        self.remain -= len(line)
        if self.remain < 0:
            raise http.client.LineTooLong('headers')
        return line


class Handler(BaseHTTPRequestHandler):
    timeout = 4  # writes, including SSE to a stalled client, are bounded
    responded = False

    def log_message(self, *args):
        pass

    def handle(self):
        def abort():
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.handshake_timer = threading.Timer(5, abort)
        self.handshake_timer.daemon = True
        self.handshake_timer.start()
        try:
            self.handle_one_request()
        finally:
            self.handshake_timer.cancel()

    def parse_request(self):
        self.responded = False
        raw = self.rfile
        self.rfile = HeaderBudget(raw)
        try:
            return super().parse_request()
        finally:
            self.rfile = raw
            self.handshake_timer.cancel()

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.dispatch
        raise AttributeError(name)

    def start_response(self, status, mime, headers=None):
        self.responded = True
        self.send_response_only(status)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def reply(self, data, status=200, mime='application/json; charset=utf-8', headers=None):
        if len(data) > HTTP_LIMIT:
            raise Refusal('too_large')
        self.start_response(status, mime, {**(headers or {}), 'Content-Length': str(len(data))})
        if self.command != 'HEAD':
            self.wfile.write(data)

    def fail(self, code):
        if not self.responded:
            self.reply(error_body(code), STATUSES[code])

    def send_error(self, code, *args):
        # The base handler's error page can echo methods, request text and the Python version.
        self.fail('too_large' if code in (414, 431) else 'invalid_request')

    def header(self, name):
        values = self.headers.get_all(name) or []
        if len(values) > 1:
            raise Refusal('invalid_request')
        return values[0] if values else None

    def authorized(self):
        current = credential(self.server.credential_file)
        supplied = self.header('Authorization') or ''
        return current is not None and supplied.isascii() and hmac.compare_digest(current, supplied.encode('ascii'))

    def dispatch(self):
        try:
            self.route()
        except Refusal as exc:
            self.fail(exc.code)
        except stream.ResetRequired:
            self.fail('reset_required')
        except QueryError as exc:
            code = getattr(exc, 'code', '')
            self.fail(code if code in STATUSES else 'invalid_request' if exc.exit_code == 2 else 'source_unavailable')
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            self.fail('source_unavailable')

    def route(self):
        if self.header('Host') != self.server.expected_host:
            raise Refusal('forbidden')
        if not self.authorized():
            raise Refusal('auth_required')
        if self.header('Origin') not in (None, 'http://' + self.server.expected_host) or self.header('Sec-Fetch-Site') == 'cross-site':
            raise Refusal('forbidden')
        if self.header('Transfer-Encoding') is not None or self.header('Expect') is not None:
            raise Refusal('invalid_request')
        if (self.request_version not in ('HTTP/1.0', 'HTTP/1.1') or len(self.path) > 4096
                or not self.path.isascii() or not self.path.startswith('/')
                or self.requestline.split()[1] != self.path or '#' in self.path or '\\' in self.path):
            raise Refusal('invalid_request')
        path, _, qs = self.path.partition('?')
        size = self.header('Content-Length')
        if size is not None:
            if not re.fullmatch('[0-9]{1,16}', size):
                raise Refusal('invalid_request')
            if int(size) > (8192 if path == '/v1/feedback' else 1048576):
                raise Refusal('too_large')
        if self.command != 'GET':
            raise Refusal('forbidden')
        if size is not None and int(size) != 0:
            raise Refusal('invalid_request')
        try:
            pairs = parse_qsl(qs, strict_parsing=True, keep_blank_values=True, max_num_fields=10, errors='strict')
        except ValueError:
            raise Refusal('invalid_request') from None
        args = dict(pairs)
        if len(args) != len(pairs):
            raise Refusal('invalid_request')
        if path == '/v1/health':
            if args:
                raise Refusal('invalid_request')
            with self.server.reader() as reader:
                rows = reader.query('SELECT imported_at FROM import_receipts ORDER BY receipt_seq DESC LIMIT 1')
                if reader.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_pages'"):
                    rows += reader.query('SELECT e.ts AS imported_at FROM event_rows AS e WHERE e.event_id = '
                                         '(SELECT checkpoint FROM source_pages ORDER BY rowid DESC LIMIT 1)')
                if any(not isinstance(r['imported_at'], str) or not re.fullmatch(
                        r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z', r['imported_at']) for r in rows):
                    raise Refusal('source_unavailable')
                last_import = max((r['imported_at'] for r in rows), default=None)
                halted = bool(reader.query("SELECT 1 FROM import_cursors WHERE state='halted' LIMIT 1"))
                data = wire({'ok': True, 'schema': 'rizzstack.rails-http/1', 'ledger_uuid': reader.ledger_uuid,
                             'ingest_head': stream.head(reader), 'runtime_manifest_sha256': self.server.runtime_digest,
                             'runtime_revision': self.server.runtime_revision, 'contract_sha256': CONTRACT_DIGEST,
                             'last_import': last_import, 'source_status': 'unavailable' if halted else 'unknown',
                             'integrity': {'status': 'unchecked', 'checked_through': None},
                             'warnings': ['source_freshness_unknown', 'clock_skew_unknown', 'coverage_unknown']
                                         + (['source_halted'] if halted else [])})
            return self.reply(data)
        fields = {'/v1/stream': {'kind', 'id'}, '/v1/events': PAGE_FIELDS, '/v1/view': PAGE_FIELDS,
                  '/v1/feedback/export': {'kind', 'id', 'format', 'limit', 'after'}}.get(path)
        if fields is None:
            raise Refusal('not_found')
        if set(args) - fields:
            raise Refusal('invalid_request')
        if not args.get('kind') or not args.get('id'):
            raise Refusal('not_found')
        selector = {k: args.pop(k) for k in ('kind', 'id')}
        if selector['kind'] not in ('job', 'attempt', 'campaign', 'session', 'event') or not public_id(selector['id']):
            raise Refusal('invalid_request')
        if path == '/v1/stream':
            if not self.server.streams.acquire(False):
                raise Refusal('capacity')
            try:
                return stream.send(self, selector, self.header('Last-Event-ID'))
            finally:
                self.server.streams.release()
        if not self.server.pages.acquire(False):
            raise Refusal('capacity')
        try:
            self.page(path, selector, args)
        finally:
            self.server.pages.release()

    def page(self, path, selector, args):
        fmt = args.pop('format', 'json')
        export = path.endswith('/export')
        if fmt not in (('csv', 'jsonl') if export else ('json', 'markdown')):
            raise Refusal('invalid_request')
        opts = {'format': 'json' if export or path == '/v1/view' else fmt}
        for k, cap in [('limit', 500), ('max_bytes', 32768)]:
            if k in args:
                if not re.fullmatch('[0-9]{1,5}', args[k]) or not 1 <= int(args[k]) <= cap:
                    raise Refusal('invalid_request')
                opts[k] = int(args[k])
        if 'after' in args:
            if len(args['after']) > 1024 or not args['after']:
                raise Refusal('invalid_request')
            opts['after'] = args['after']
        if 'include' in args:
            opts['include'] = args['include'].split(',') if args['include'] else []
        if export:
            opts['include'] = ['feedback']
        if 'show_tokens' in args:
            if args['show_tokens'] not in ('true', 'false'):
                raise Refusal('invalid_request')
            opts['show_tokens'] = args['show_tokens'] == 'true'
        req = make_request(selector['kind'], selector['id'], **opts)
        with self.server.reader() as reader:
            # Capture the stream position *before* the snapshot so a concurrent
            # append can cause a redundant invalidation but is never missed.
            start = stream.cursor(reader.ledger_uuid, selector, stream.head(reader))
            result = (query_view_page if path == '/v1/view' else query_events)(req, reader)
            headers = {'X-Rails-Stream-Cursor': start, 'X-Rails-Has-More': str(result['has_more']).lower(),
                       'X-Rails-Truncated': str(result['truncated']).lower()}
            if result['next_cursor']:
                headers['X-Rails-Next-Cursor'] = result['next_cursor']
            if path == '/v1/view':
                data = wire(result['items'][0])
            elif export:
                # R11's history-wide convenience functions must never be used here.
                rows = [r for r in result['items'] if r['kind'] in
                        ('feedback.recorded', 'intervention.requested', 'intervention.result')]
                if fmt == 'csv':
                    fields = ('event_id', 'kind', 'lane_id', 'target_event_id', 'outcome', 'rating', 'category')
                    data = feedback_csv(rows, fields).encode('utf-8')
                else:
                    data = b''.join(wire(row) + b'\n' for row in rows)
            else:
                data = wire(result)
        mime = {'csv': 'text/csv; charset=utf-8', 'jsonl': 'application/x-ndjson'}.get(fmt, 'application/json; charset=utf-8')
        self.reply(data, mime=mime, headers=headers)
