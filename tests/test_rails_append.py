"""Producer HTTP acceptance: real sockets, temporary credentials, canonical SQLite."""
from copy import deepcopy
from http.client import HTTPConnection
import json
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'contrib'))
from rails_server.http import make_server
from rails_server.producer import make_producer_server
from rizzstack_rails import RailsLedger, contracts


class AppendHTTP(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.db = root / 'ledger.sqlite'
        ledger = RailsLedger(self.db)
        uid = ledger.ledger_uuid
        ledger.close()
        self.read_file, self.write_file = root/'reader', root/'producer'
        self.read_key, self.write_key = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        for p, key in [(self.read_file,self.read_key),(self.write_file,self.write_key)]:
            p.write_text(key); p.chmod(0o600)
        self.scope = dict.fromkeys(contracts.SCOPE_FIELDS)
        self.scope['job_id'] = 'job-test'
        self.policy = {'ledger_uuid':uid,'adapter':'local-trace','instance':'test','lane_id':'lane-test',
                       'scope':self.scope, 'kinds':['tool.finish']}
        self.service = self.start(make_producer_server('127.0.0.1',0,self.db,self.write_file,self.read_file,self.policy))
        self.reader = self.start(make_server('127.0.0.1',0,self.db,self.read_file))

    def start(self, server):
        t = threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01})
        t.start()
        self.addCleanup(server.server_close); self.addCleanup(t.join); self.addCleanup(server.shutdown)
        return server

    def record(self, n):
        return {'schema':'rizzstack.rails-candidate/1','dedupe_key':f'push:local-trace:test:{n}',
                'kind':'tool.finish','source':{'adapter':'local-trace','instance':'test','record_id':f'r{n}','revision':'r1'},
                'authority':'imported_observation','scope':self.scope.copy(),'lane_id':'lane-test','parent_lane_id':None,
                'parent_event_id':None,'occurred_at':None,'duration_ms':None,'timing_quality':'unknown',
                'redaction_policy':'rails-safe/1','payload':{'call_id':f'call-{n}','tool_name':'shell','command_family':'git',
                    'outcome':'ok','summary':'Tool completion observed','evidence_ref':None}}

    def post(self, records, *, key=None, server=None, headers=None, raw=None, path='/v1/append', method='POST'):
        conn = HTTPConnection(*(server or self.service).server_address[:2],timeout=5)
        try:
            body = raw if raw is not None else json.dumps({'schema':'rizzstack.rails-append/1','records':records}).encode()
            conn.request(method,path,body=body,headers={'Authorization':'Bearer '+(self.write_key if key is None else key),
                         'Content-Type':'application/json', **(headers or {})})
            res = conn.getresponse()
            return res.status, json.loads(res.read())
        finally:
            conn.close()

    def state(self):
        db = RailsLedger(self.db,read_only=True)
        try:
            return [json.loads(r['envelope_json']) for r in db.query('SELECT envelope_json FROM event_rows ORDER BY ingest_seq')]
        finally: db.close()

    def test_committed_receipts_replay_and_full_rollback(self):
        first = [self.record(1),self.record(2)]
        status, obj = self.post(first)
        self.assertEqual(status,200,obj)
        self.assertEqual(set(obj),{'ok','committed_cursor','receipts'})
        self.assertIsNone(obj['committed_cursor'])
        events = self.state()
        self.assertEqual(len(events),3)  # two observations and one R04 receipt
        for r,e in zip(obj['receipts'],events,strict=False):
            self.assertEqual(r, {k:e[k] for k in ('event_id','hash','seq')} | {'duplicate':False})
            self.assertEqual((e['source']['instance'], e['authority']),('test','imported_observation'))
        self.assertEqual(len(obj['receipts']),2)
        status, replay = self.post(first)
        self.assertEqual(replay['receipts'],[dict(r,duplicate=True) for r in obj['receipts']])
        conflict = deepcopy(first[0]); conflict['payload']['outcome'] = 'failed'
        status, err = self.post([self.record(3),conflict]); self.assertEqual((status,err['error']['code']),(409,'conflict'))
        self.assertEqual(self.state(),events)

    def test_separated_identities_and_routes(self):
        for kw in [{'key':self.read_key}, {'server':self.reader,'key':self.write_key}, {'key':''}]:
            self.assertEqual(self.post([],**kw)[0],401)
        self.assertEqual(self.post([],server=self.reader,key=self.read_key)[0],403)
        self.assertEqual(self.post([],headers={'Origin':'null'})[0],403)
        self.assertEqual(self.post([],headers={'Host':'localhost'})[0],403)
        self.assertEqual(self.post([],path='/v1/feedback')[0],404)
        self.assertEqual(self.post([],path='/v1/append?token=x')[0],404)
        self.assertEqual(self.post([],path='/v1/health',method='GET')[0],404)
        self.write_file.write_text(self.read_key)
        self.assertNotEqual(self.post([self.record(1)],key=self.read_key)[0],200)
        self.assertFalse(self.state())

    def test_forbidden_provenance_scope_and_kind_roll_back(self):
        for key,value in [('authority','verifier_record'), ('kind','acceptance.result'), ('scope',dict(self.scope,job_id='other')),
                         ('source',dict(self.record(1)['source'],adapter='other')), ('dedupe_key','reserved'),
                         ('lane_id','other'),('parent_event_id','other:1')]:
            with self.subTest(key=key):
                self.assertEqual(self.post([self.record(1),dict(self.record(2),**{key:value})])[0],403)
                self.assertFalse(self.state())

    def test_strict_wire_private_text_and_caps(self):
        raw = self.record(1)
        for record in [dict(raw,seq=1),dict(raw,schema='rizzstack.rails/1'),dict(raw,scope={'job_id':'job-test'}),
                       dict(raw,payload=dict(raw['payload'],argv=['private'])),dict(raw,timing_quality='reported'),
                       dict(raw,payload=dict(raw['payload'],summary='Private source text must not be stored.'))]:
            self.assertIn(self.post([record])[0],(400,403))
        for kw in [{'raw':b'{"schema":"a","schema":"b"}'},{'raw':b'\xff'},{'headers':{'Content-Length':'-2'}},
                   {'headers':{'Transfer-Encoding':'chunked'}},{'headers':{'Content-Type':'text/plain'}},
                   {'raw':b'{"schema":"rizzstack.rails-append/1","records":[],"url":"x"}'}]:
            self.assertEqual(self.post([],**kw)[0],400)
        self.assertEqual(self.post([raw]*501)[0],413)
        self.assertEqual(self.post([],headers={'Content-Length':'1048577'})[0],413)
        self.assertEqual(self.post([dict(raw,padding='x'*65536)])[0],413)
        self.assertFalse(self.state())
