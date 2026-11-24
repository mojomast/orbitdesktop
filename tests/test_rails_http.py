"""Offline HTTP acceptance against an isolated, real canonical Rails ledger."""
import hashlib
import http.client
import json
from pathlib import Path
import secrets
import sqlite3
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'contrib'))

from rails_server.http import make_server
from rizzstack_rails import RailsLedger
from rizzstack_rails.importer import Importer


class ReadService(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.path = self.root / 'observed.sqlite'
        self.token_file = self.root / 'read'
        self.token = secrets.token_urlsafe(32)
        self.token_file.write_text(self.token)
        self.token_file.chmod(0o600)
        self.writer = RailsLedger(self.path)
        self.addCleanup(self.writer.close)
        self.server = make_server('127.0.0.1', 0, self.path, self.token_file)
        self.server.poll_interval = .02
        self.addCleanup(self.server.server_close)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)
        self.sel = '?kind=attempt&id=a1'

    def append(self, n, attempt='a1', writer=None):
        return (writer or self.writer).append('tool.finish', source={'adapter': 'launcher-log',
            'instance': 'worker-1', 'record_id': f'r{n}', 'revision': 'v1'},
            scope={'attempt_id': attempt}, lane={'lane_id': attempt},
            authority='worker_report', dedupe_key=f'k{n}', timing_quality='unknown',
            payload={'call_id': f'c{n}', 'tool_name': 'shell', 'command_family': 'git',
                     'outcome': 'ok', 'summary': 'ok', 'evidence_ref': 'ref:1'})['event_id']

    def get(self, route, headers=None, method='GET', stream=False):
        c = http.client.HTTPConnection(*self.server.server_address[:2], timeout=3)
        self.addCleanup(c.close)
        hdrs = {'Authorization': 'Bearer ' + self.token}
        hdrs.update(headers or {})
        c.request(method, route, headers=hdrs)
        reply = c.getresponse()
        if stream:
            self.addCleanup(reply.close)
            return reply
        return reply.status, json.loads(reply.read()), reply.headers

    def error(self, expected, code, *args, **kw):
        status, obj, headers = self.get(*args, **kw)
        self.assertEqual((status, obj['error']['code']), (expected, code))
        self.assertEqual(set(obj['error']), {'request_id', 'code', 'retryable'})
        self.assertNotIn(self.token, json.dumps(obj))

    def test_auth_host_query_method_and_size(self):
        for route in ['/v1/health', '/v1/events', '/v1/view', '/v1/stream', '/unknown']:
            self.error(401, 'auth_required', route, {'Authorization': ''})
        self.error(403, 'forbidden', '/v1/health', {'Origin': 'null'})
        self.error(403, 'forbidden', '/v1/health', {'Host': 'bad.invalid'})
        self.error(400, 'invalid_request', '/v1/health?token=' + self.token)
        self.error(400, 'invalid_request', '/v1/view' + self.sel + '&kind=job')
        self.error(400, 'invalid_request', '/v1/events' + self.sel + '&db=x')
        self.error(400, 'invalid_request', '/v1/events' + self.sel + '&limit=501')
        self.error(400, 'invalid_request', '/v1/health', {'Transfer-Encoding': 'chunked'})
        self.error(400, 'invalid_request', '/v1/health', {'Content-Length': '-1'})
        self.error(413, 'too_large', '/v1/health', {'X-Padding': 'x' * 18000})
        self.error(413, 'too_large', '/v1/append', {'Content-Length': '1048577'}, 'POST')
        for path in ['append', 'feedback', 'interventions']:
            self.error(403, 'forbidden', '/v1/' + path, method='POST')

    def test_bind_and_private_credential(self):
        for host in ['0.0.0.0', '::', 'localhost']:
            with self.assertRaises(ValueError):
                make_server(host, 0, self.path, self.token_file)
        self.token_file.chmod(0o644)
        self.error(401, 'auth_required', '/v1/health')
        with self.assertRaises(ValueError):
            make_server('127.0.0.1', 0, self.path, self.token_file)

    def test_configured_ledger_missing_or_wrong_does_not_initialize(self):
        old_path = self.path.with_suffix('.moved')
        self.path.rename(old_path)
        self.error(503, 'source_unavailable', '/v1/health')
        self.assertFalse(self.path.exists())
        self.path.write_bytes(b'not a rails database')
        self.error(503, 'source_unavailable', '/v1/view' + self.sel)
        self.assertEqual(self.path.read_bytes(), b'not a rails database')

    def test_read_pages_view_identity_and_db_unchanged(self):
        ids = [self.append(i) for i in range(3)]
        outsider = self.append(3, 'a2')
        def digest():
            return [hashlib.sha256(f.read_bytes()).hexdigest() for f in
                    (self.path, Path(str(self.path) + '-wal'))]
        before = digest()
        status, obj, _ = self.get('/v1/health')
        self.assertEqual(status, 200)
        self.assertEqual(obj['integrity']['status'], 'unchecked')
        status, obj, hdr = self.get('/v1/events' + self.sel + '&limit=1')
        self.assertEqual(status, 200, obj)
        self.assertEqual([i['event_id'] for i in obj['items']], ids[:1])
        self.assertTrue(obj['has_more'])
        self.assertTrue(hdr['X-Rails-Stream-Cursor'])
        _, page, _ = self.get('/v1/events' + self.sel + '&limit=1&after=' + obj['next_cursor'])
        self.assertEqual(page['items'][0]['event_id'], ids[1])
        status, view, _ = self.get('/v1/view' + self.sel)
        self.assertEqual(status, 200, view)
        self.assertEqual(view['schema'], 'rizzstack.rails-view/1')
        self.assertEqual([m['event_id'] for l in view['lanes'] for m in l['marks']], ids)
        self.assertNotIn(outsider, json.dumps(view))
        self.assertEqual(digest(), before)

    def test_view_pages_are_snapshot_stable_and_cursor_bound(self):
        ids = [self.append(i) for i in range(2)]
        _, view, hdr = self.get('/v1/view' + self.sel + '&limit=1')
        page = hdr['X-Rails-Next-Cursor']
        self.assertEqual(view['lanes'][0]['marks'][0]['event_id'], ids[0])
        self.append(2)
        _, view, hdr = self.get('/v1/view' + self.sel + '&limit=1&after=' + page)
        self.assertEqual(hdr['X-Rails-Has-More'], 'false')
        self.assertEqual(view['lanes'][0]['marks'][0]['event_id'], ids[1])
        self.error(409, 'reset_required', '/v1/view?kind=job&id=other&after=' + page)

    def test_export_includes_only_scoped_feedback_revisions(self):
        from rizzstack_rails import feedback
        target1, target2 = self.append(1), self.append(2, 'a2')
        ids = []
        for scope, target in [('a1', target1), ('a2', target2)]:
            row = feedback.record(self.writer, target_event_id=target, rating=1,
                note='example note', category='quality', scope={'attempt_id': scope}, idempotency_key=scope)
            ids.append(row['event_id'])
        url = '/v1/feedback/export' + self.sel + '&format='
        csv = self.get(url+'csv', stream=True).read().decode()
        lines = self.get(url+'jsonl', stream=True).read().splitlines()
        self.assertIn(ids[0], csv)
        self.assertNotIn(ids[1], csv)
        self.assertEqual([json.loads(line)['event_id'] for line in lines], ids[:1])
        self.assertNotIn(b'example note', b''.join(lines))

    def test_malformed_selected_observation_is_a_closed_integrity_error(self):
        self.append(1)
        db = sqlite3.connect(self.path)
        try:
            with db:
                db.execute('DROP TRIGGER event_rows_no_update')
                db.execute("UPDATE event_rows SET rails_hash='mismatch'")
        finally:
            db.close()
        self.error(409, 'source_fork', '/v1/events' + self.sel)

    def test_existing_reader_does_not_create_journal_sidecars(self):
        self.writer.close()
        names = sorted(p.name for p in self.root.iterdir())
        response, _, _ = self.get('/v1/health')
        self.assertIn(response, [200, 503])
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), names)

    def frame(self, response):
        frame = {}
        while True:
            line = response.readline()
            if not line or line == b'\n' and frame:
                return frame
            if b': ' in line:
                key, val = line.decode().rstrip().split(': ', 1)
                frame[key] = val

    def test_stream_snapshot_cursor_filtered_replay_rotation_capacity(self):
        self.append(1)
        _, _, hdr = self.get('/v1/view' + self.sel)
        start = hdr['X-Rails-Stream-Cursor']
        self.append(2, 'a2')
        self.append(3)
        stream = self.get('/v1/stream' + self.sel, {'Last-Event-ID': start}, stream=True)
        self.assertEqual(stream.status, 200)
        self.assertEqual(stream.headers.get_content_type(), 'text/event-stream')
        self.assertEqual(self.frame(stream)['event'], 'ready')
        mark = self.frame(stream)
        self.assertEqual(mark['event'], 'invalidate')
        self.assertNotEqual(start, mark['id'])
        self.error(409, 'reset_required', '/v1/stream?kind=attempt&id=a2', {'Last-Event-ID': mark['id']})
        more = [self.get('/v1/stream' + self.sel, {'Last-Event-ID': mark['id']}, stream=True) for _ in range(7)]
        self.assertEqual([s.status for s in more], [200] * 7)
        self.error(429, 'capacity', '/v1/stream' + self.sel)
        self.token_file.write_text(secrets.token_urlsafe(32))
        self.assertEqual(stream.read(), b'')
        self.error(401, 'auth_required', '/v1/health')

    def test_origin_import_uses_local_arrival_for_replay_and_original_id_for_detail(self):
        _, _, hdr = self.get('/v1/view' + self.sel)
        origin = RailsLedger(self.root / 'worker.sqlite')
        self.addCleanup(origin.close)
        eid = self.append(1, writer=origin)
        row = origin.query('SELECT envelope_json FROM event_rows')[0]['envelope_json']
        Importer(self.writer).import_origin_page(origin.chain_id, [row])
        self.server.stream_ttl = .1
        s = self.get('/v1/stream' + self.sel, {'Last-Event-ID':hdr['X-Rails-Stream-Cursor']}, stream=True)
        self.assertEqual(self.frame(s)['event'], 'ready')
        self.assertEqual(self.frame(s)['event'], 'invalidate')
        self.assertEqual(s.read(), b'')  # stream expires even if the credential did not rotate
        _, result, _ = self.get('/v1/events?kind=event&id=' + eid)
        self.assertEqual([i['event_id'] for i in result['items']], [eid])

    def test_ledger_replacement_forces_stream_reset(self):
        _, _, hdr = self.get('/v1/view' + self.sel)
        # Replace all companions by stopping the isolated writer first.
        self.writer.close()
        self.path.rename(self.root / 'previous.sqlite')
        other = RailsLedger(self.path)
        self.addCleanup(other.close)
        self.error(409, 'reset_required', '/v1/stream' + self.sel, {'Last-Event-ID': hdr['X-Rails-Stream-Cursor']})


if __name__ == '__main__':
    unittest.main()
