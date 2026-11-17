"""Opt-in coordinator producer ingress. Never imported by the Orbit read service."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hmac
import json
from pathlib import Path
import re
import sqlite3
import sys
import threading
import time
from uuid import UUID

from .http import Handler, Refusal, Server, credential, wire
from rizzstack_rails import RailsLedger, contracts, privacy
from rizzstack_rails.importer import Importer
from rizzstack_rails.ledger import IdempotencyConflict
from rizzstack_rails.projection import public_id
from rizzstack_rails.shell_labels import command_family, tool_label

KINDS = {'tool.start', 'tool.finish', 'lane.open', 'lane.close'}
ROLE = 'imported_observation'
MAX_BODY = 1 << 20
MAX_RECORD = 1 << 16


def grant(config):
    if not isinstance(config,dict) or set(config) != {'ledger_uuid','adapter','instance','kinds','lane_id','scope'}:
        raise ValueError('invalid producer configuration')
    uid = str(UUID(config['ledger_uuid']))
    if (uid != config['ledger_uuid'] or not re.fullmatch(r'local-[a-z0-9-]{1,32}', config['adapter'])
            or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}',config['instance']) or not public_id(config['lane_id'])):
        raise ValueError('invalid producer identity')
    kinds = config['kinds']
    if not isinstance(kinds,list) or not 1 <= len(kinds) <= len(KINDS) or not set(kinds) <= KINDS:
        raise ValueError('invalid producer kinds')
    scope = config['scope']
    if not isinstance(scope,dict) or set(scope) - set(contracts.SCOPE_FIELDS):
        raise ValueError('invalid producer scope')
    # Use the canonical builder to check and complete trusted nullable scope fields.
    body = contracts.event_body('lane.open', dict(adapter=config['adapter'], instance=config['instance'],
        record_id='config', revision='1'), scope, {'status':'open'}, ROLE, {'lane_id':config['lane_id']},
        None, None, 'unknown', contracts.POLICY)
    if privacy.scrub_structure(body['scope']) != body['scope']:
        raise ValueError('unsafe producer scope')
    return dict(config, kinds=frozenset(kinds), scope=body['scope'])


def parse_batch(data):
    """Bound the decoder's containers/slots, including malformed documents."""
    # Backslash, quotes and structural characters are single bytes in UTF-8.
    quoted = escaped = False
    depth = tokens = 0
    for b in data:
        if quoted:
            if escaped: escaped = False
            elif b == 92: escaped = True
            elif b == 34: quoted = False
        elif b == 34: quoted = True
        elif b in (91,123,44,58):
            tokens += 1
            depth += b in (91,123)
            if tokens > 96000 or depth > 8:
                raise Refusal('too_large')
        elif b in (93,125):
            depth -= 1
            if depth < 0: raise Refusal('invalid_request')

    def invalid(_): raise Refusal('invalid_request')
    def integer(s): return int(s) if len(s.lstrip('-')) <= 16 else invalid(s)
    try:
        doc = json.loads(data.decode('utf-8'), object_pairs_hook=contracts._pairs_without_duplicates,
                         parse_int=integer, parse_float=invalid, parse_constant=invalid)
    except (ValueError, contracts.RailsRefusal):
        raise Refusal('invalid_request') from None
    if (not isinstance(doc,dict) or set(doc) != {'schema','records'} or doc['schema'] != 'rizzstack.rails-append/1'
            or not isinstance(doc['records'],list)):
        raise Refusal('invalid_request')
    if len(doc['records']) > 500:
        raise Refusal('too_large')
    return doc['records']


def validate_record(record, policy):
    if len(contracts.canonicalize(record)) > MAX_RECORD:
        raise Refusal('too_large')
    if not isinstance(record,dict) or record.get('schema') != 'rizzstack.rails-candidate/1':
        raise Refusal('invalid_request')
    s, p = record.get('source'), record.get('payload')
    kind, key = record.get('kind'), record.get('dedupe_key')
    if not isinstance(s,dict) or not isinstance(p,dict) or not isinstance(kind,str) or not isinstance(key,str):
        raise Refusal('invalid_request')
    if (record.get('authority') != ROLE or kind not in policy['kinds'] or record.get('scope') != policy['scope']
            or (s.get('adapter'),s.get('instance')) != (policy['adapter'],policy['instance'])
            or record.get('lane_id') != policy['lane_id'] or record.get('parent_lane_id') is not None
            or record.get('parent_event_id') is not None or not key.startswith(f"push:{policy['adapter']}:{policy['instance']}:")):
        raise Refusal('forbidden')
    if (not public_id(key) or not public_id(s.get('record_id')) or not public_id(s.get('revision'))
            or privacy.scrub_structure(record) != record):
        raise Refusal('invalid_request')
    if kind.startswith('tool.'):
        # Never accept arbitrary prose or command lines as a producer's summary/family.
        summary = 'Tool call observed' if kind == 'tool.start' else 'Tool completion observed'
        family = p.get('command_family')
        if (p.get('summary') not in ('', '[redacted]', summary) or tool_label(p.get('tool_name')) != p.get('tool_name')
                or family is not None and command_family(family) != family or not public_id(p.get('call_id'))
                or p.get('evidence_ref') is not None and not public_id(p['evidence_ref'])):
            raise Refusal('invalid_request')
    elif p.get('status') != ('open' if kind == 'lane.open' else 'closed'):
        raise Refusal('invalid_request')
    # R04 checks all flat candidate fields, frozen payload and exact normalized
    # bytes (no legacy defaults/repairs) before starting its SQLite transaction.


class Producer(Server):
    def __init__(self, addr, db, producer_file, read_file, config):
        self.policy = grant(config)
        self.read_file = Path(read_file)
        self.write_file = Path(producer_file)
        if not self.read_file.is_absolute() or self.current_key() is None:
            raise ValueError('distinct private credentials required')
        super().__init__(addr, db, producer_file)
        self.slot = threading.BoundedSemaphore(1)
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='producer-ledger')
        try:
            self.writer = self.executor.submit(self.open_existing).result()
        except BaseException:
            self.executor.shutdown(); super().server_close()
            raise

    def finish_request(self, request, client_address):
        ProducerHandler(request, client_address, self)

    def current_key(self):
        read = credential(self.read_file)
        key = credential(self.write_file)
        if read and key and not hmac.compare_digest(read,key):
            return key
        return None

    def open_existing(self):
        # State directory and grant are administrator-owned. Pin the existing DB
        # identity at startup and keep one writer connection, never reopen on POST.
        self.identity = self.db.stat()
        with closing(RailsLedger(self.db,read_only=True)) as reader:
            if reader.ledger_uuid != self.policy['ledger_uuid'] or len(reader.chain_id) > 80 or not public_id(reader.chain_id):
                raise ValueError('ledger identity mismatch')
        writer = RailsLedger(self.db,allowed_authorities={ROLE},min_free_bytes=16<<20)
        if writer.ledger_uuid != self.policy['ledger_uuid'] or not self.identity_match():
            writer.close(); raise ValueError('ledger replaced')
        return writer

    def identity_match(self):
        st = self.db.stat()
        return (st.st_dev, st.st_ino) == (self.identity.st_dev, self.identity.st_ino)

    def append(self, records, supplied):
        def reauthorize():
            key = self.current_key()
            if not key or not hmac.compare_digest(key, supplied): raise Refusal('auth_required')
            if not self.identity_match(): raise Refusal('source_unavailable')
        reauthorize()
        self.writer.hooks['before_commit'] = reauthorize
        try:
            imp = Importer(self.writer, authorities={ROLE})
            batch = imp.commit_batch('producer-http', self.policy['adapter']+':'+self.policy['instance'], records,
                                     expected_cursor=None, next_cursor=None)
        finally:
            self.writer.hooks.pop('before_commit', None)
        # This POST is keyed push, not cursor-based origin replication. The /1
        # result permits null committed_cursor. A replay publishes no checkpoint.
        return {'ok':True, 'committed_cursor':None, 'receipts':[
            {'event_id':r['event_id'], 'seq':r['seq'], 'hash':r['hash'], 'duplicate':r['duplicated']}
            for r in batch['receipts']]}

    def server_close(self):
        super().server_close()
        if hasattr(self,'writer'):
            self.executor.submit(self.writer.close).result()
            self.executor.shutdown()
            del self.writer


class ProducerHandler(Handler):
    def route(self):
        if self.header('Host') != self.server.expected_host: raise Refusal('forbidden')
        supplied = (self.header('Authorization') or '').encode('latin-1')
        key = self.server.current_key()
        if not key or not hmac.compare_digest(key,supplied): raise Refusal('auth_required')
        if (self.header('Origin') is not None or self.header('Cookie') is not None
                or any(k.lower().startswith('sec-fetch-') for k in self.headers)):
            raise Refusal('forbidden')
        if self.requestline.split()[1] != '/v1/append' or self.command != 'POST':
            raise Refusal('not_found')
        if (self.request_version not in ('HTTP/1.0','HTTP/1.1') or self.header('Transfer-Encoding') is not None
                or self.header('Content-Encoding') is not None or self.header('Expect') is not None
                or not re.fullmatch(r'application/json(?:\s*;\s*charset=utf-8)?',self.header('Content-Type') or '',re.I)):
            raise Refusal('invalid_request')
        size = self.header('Content-Length') or ''
        if not re.fullmatch('[0-9]{1,16}',size) or int(size)==0: raise Refusal('invalid_request')
        if int(size)>MAX_BODY: raise Refusal('too_large')
        if not self.server.slot.acquire(False): raise Refusal('capacity')
        try:
            data = bytearray()
            deadline = time.monotonic()+5
            while len(data)<int(size):
                remaining = deadline-time.monotonic()
                if remaining<=0: raise Refusal('invalid_request')
                self.connection.settimeout(min(self.timeout,remaining))
                piece = self.rfile.read1(min(65536,int(size)-len(data)))
                if not piece: raise Refusal('invalid_request')
                data.extend(piece)
            self.connection.settimeout(self.timeout)
            records = parse_batch(data)
            for record in records:
                validate_record(record,self.server.policy)
            result = self.server.executor.submit(self.server.append,records,supplied).result()
            self.reply(wire(result))
        except IdempotencyConflict:
            raise Refusal('conflict') from None
        except contracts.RailsRefusal as exc:
            raise Refusal('too_large' if exc.code=='too_large' else 'invalid_request') from None
        finally:
            self.server.slot.release()


def make_producer_server(host, port, db, producer_file, read_file, policy):
    return Producer((host,port),db,producer_file,read_file,policy)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for arg in ('ledger','policy','producer-token-file','read-token-file'):
        p.add_argument('--'+arg, required=True,type=Path)
    p.add_argument('--port',type=int,required=True)
    args = p.parse_args()
    try:
        if not args.policy.is_absolute() or not args.policy.is_file() or args.policy.stat().st_mode & 0o077:
            raise ValueError
        with args.policy.open('rb') as f: policy = f.read(8193)
        if len(policy)>8192 or not 1<=args.port<=65535: raise ValueError
        config = contracts.parse_text(policy.decode('utf-8'))
        with make_producer_server('127.0.0.1',args.port,args.ledger,args.producer_token_file,args.read_token_file,config) as server:
            server.serve_forever()
    except (OSError, ValueError, KeyError, TypeError, AttributeError, contracts.RailsRefusal, sqlite3.Error):
        print('producer configuration or ledger unavailable', file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
