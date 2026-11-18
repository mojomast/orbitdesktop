"""Disposable R12 source for hive-follow.browser.mjs; commands only travel on stdin."""
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import secrets
import subprocess
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rails_fixture', ROOT/'tests/rails-live.browser.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def send(value):
    print(json.dumps(value), flush=True)


with TemporaryDirectory(prefix='selected-follow-') as tmp, ExitStack() as cleanup:
    root = Path(tmp)
    reader = secrets.token_urlsafe(36)
    token_file = root/'upstream-read'
    token_file.write_text(reader)
    token_file.chmod(0o600)
    ledger = fixture.RailsLedger(root/'ledger.sqlite')
    cleanup.callback(ledger.close)
    first = fixture.event(ledger, 1)
    number = 1

    def serve(port):
        process = subprocess.Popen([sys.executable, str(ROOT/'tests/rails-live.browser.py'),
            '--fixture-reader', str(port), str(root)], stdout=subprocess.PIPE, text=True)
        return process, int(process.stdout.readline())

    service, port = serve(0)

    def stop():
        service.terminate()
        service.wait(timeout=5)
        service.stdout.close()

    cleanup.callback(stop)
    send(dict(reader=reader, port=port, first=first))
    for line in sys.stdin:
        op = line.strip()
        if op == 'stop':
            stop()
            send('stopped')
        elif op == 'restart':
            service, port = serve(port)
            send('resumed')
        elif op == 'replace':
            # Reader is stopped. A different compatible ledger has the same
            # selector but a distinct epoch/sequence. No production DB or file
            # is replaced; the fixture reader now serves a fresh temp directory.
            root = root/'replacement'
            root.mkdir()
            token_file = root/'upstream-read'
            token_file.write_text(reader)
            token_file.chmod(0o600)
            ledger = fixture.RailsLedger(root/'ledger.sqlite')
            cleanup.callback(ledger.close)
            baseline = fixture.event(ledger, number + 1)
            number += 1
            service, port = serve(port)
            send(baseline)
        elif op == 'append':
            number += 1
            send(fixture.event(ledger, number))
        elif op == 'revoke':
            token_file.write_text(secrets.token_urlsafe(36))
            send('revoked')
        elif op == 'unrelated':
            number += 1
            row = ledger.append('tool.finish', source={'adapter':'launcher-log', 'instance':'other',
                'record_id':f'other-{number}', 'revision':'v1'}, scope={'attempt_id':'att-other'},
                lane={'lane_id':'other'}, authority='worker_report', dedupe_key=f'other-{number}',
                timing_quality='unknown', payload={'call_id':f'call-{number}', 'tool_name':'shell',
                'command_family':'git', 'outcome':'ok', 'summary':'ok', 'evidence_ref':'ref:1'})
            send(row['event_id'])
        else:
            raise ValueError('unknown fixture operation')
