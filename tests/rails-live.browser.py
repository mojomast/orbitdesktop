"""Real owner shell, opaque Observatory/render frames, Node proxy and R12 reader.

Uses the repo's playwright-core package. Set CHROMIUM_EXECUTABLE if the matching
Playwright browser is not installed. All servers, credentials and state are new.
"""
import contextlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'contrib'))
from rails_server.http import make_server
from rizzstack_rails import RailsLedger


def event(ledger, number):
    return ledger.append('tool.finish', source={'adapter': 'launcher-log', 'instance': 'worker-1',
        'record_id': f'fixture-{number}', 'revision': 'v1'}, scope={'job_id':'job-fixture','attempt_id': 'att-fixture'},
        lane={'lane_id': 'worker-1'}, authority='worker_report', dedupe_key=f'fixture-{number}',
        timing_quality='unknown', payload={'call_id': f'call-{number}', 'tool_name': 'shell',
        'command_family': 'git', 'outcome': 'ok', 'summary': 'ok', 'evidence_ref': 'ref:1'})['event_id']


def run():
    with tempfile.TemporaryDirectory(prefix='orbit-rails-') as tmp, contextlib.ExitStack() as cleanup:
        root = Path(tmp)
        for folder in ('runtime', 'home', 'cwd', 'apps'):
            (root / folder).mkdir()
        for folder in ('src', 'server', 'scripts', 'contracts', 'docs', 'public', 'packages'):
            shutil.copytree(ROOT / folder, root / folder, ignore=shutil.ignore_patterns('node_modules', '__pycache__'))
        shutil.copytree(ROOT / 'apps/rizzstack-rails', root / 'apps/rizzstack-rails')
        shutil.copytree(ROOT / 'apps/rizzstack-observatory', root / 'runtime/apps/rizzstack-observatory')
        for name in ('package.json', 'index.html', 'tsconfig.json', 'vite.config.js'):
            shutil.copy2(ROOT / name, root / name)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'TMPDIR': str(root),
               'ORBIT_BUILD_SCRATCH': str(root.parent), 'ORBIT_AGENT_DISCOVERY': 'off'}
        dist = os.getenv('ORBIT_RAILS_TEST_DIST')  # Optional, explicit isolated build of this source.
        if dist:
            (root / 'dist').symlink_to(Path(dist).resolve(), target_is_directory=True)
        else:
            subprocess.run(['node', str(ROOT / 'scripts/isolated_build.mjs'), '--dest', str(root / 'dist')],
                           cwd=ROOT, env=env, check=True)

        owner, reader = secrets.token_urlsafe(36), secrets.token_urlsafe(36)
        for name in ('upstream-read', 'proxy-read'):
            f = root / name
            f.write_text(reader)
            f.chmod(0o600)
        ledger = RailsLedger(root / 'ledger.sqlite')
        cleanup.callback(ledger.close)
        original = event(ledger, 1)
        workspace = str(uuid4()); writer = None
        if '--signed-feedback' in sys.argv:
            from rails_owner_ssh_fixture import Fixture
            writer = Fixture(root,ledger,workspace,cleanup)
        # Keep R12 in its own process, as deployed. Its read-only file-header
        # checks must not share process-scoped SQLite file locks with the writer.
        def serve(port):
            process = subprocess.Popen([sys.executable, __file__, '--fixture-reader', str(port), str(root)],
                                       env=env, stdout=subprocess.PIPE, text=True)
            try:
                return process, int(process.stdout.readline())
            except BaseException:
                process.kill(); process.wait(); raise
        service, reader_port = serve(0)
        def stop_reader():
            service.terminate(); service.wait(timeout=5); service.stdout.close()
        cleanup.callback(stop_reader)

        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'], cwd=root,
            env={**env, **(writer.env if writer else {}), 'PORT': str(port), 'ORBIT_TOKEN': owner, 'ORBIT_RUNTIME_DIR': str(root/'runtime'),
                 'ORBIT_RAILS_PORT': str(reader_port), 'ORBIT_RAILS_READ_TOKEN_FILE': str(root/'proxy-read'),
                 'ORBIT_CWD': str(root/'cwd'), 'ORBIT_TMUX_SOCKET': 'rails-' + uuid4().hex[:20],
                 'ORBIT_TMUX_CONFIG': '/dev/null'}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        def stop():
            server.terminate()
            try: server.wait(timeout=4)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
        cleanup.callback(stop)
        for _ in range(120):
            if server.poll() is not None: raise RuntimeError('Isolated Orbit server exited before readiness')
            try:
                with urlopen(origin + '/api/health', timeout=.5): break
            except OSError: time.sleep(.05)
        else: raise RuntimeError('Isolated Orbit boot timed out')

        # Serve this synthetic snapshot through the real sandbox app-file route. No
        # collector, existing workspace, owner session, or terminal is contacted.
        snapshot = {'schema':'rizzstack.observability/snapshot/1', 'fleet':{'attempts':[
            {'attempt_id':'att-fixture','state':'running'}, {'id':'legacy-row','state':'unknown'}]},
            'pipeline':{'jobs':[{'job_id':'job-fixture','tasks':[]}]}}
        (root / 'runtime/apps/rizzstack-observatory/snapshot.json').write_text(json.dumps(snapshot))
        # Reuse the production Playwright dependency rather than requiring another Python runtime package.
        js_env = {**env, 'PLAYWRIGHT_BROWSERS_PATH':os.getenv('PLAYWRIGHT_BROWSERS_PATH', str(Path.home()/'.cache/ms-playwright'))}
        if os.getenv('CHROMIUM_EXECUTABLE'): js_env['CHROMIUM_EXECUTABLE'] = os.environ['CHROMIUM_EXECUTABLE']
        js = subprocess.Popen(['node', str(ROOT / 'tests/rails-live.browser.mjs')], cwd=ROOT, env=js_env,
                              text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        cleanup.callback(lambda: js.kill() if js.poll() is None else None)
        js.stdin.write(json.dumps(dict(origin=origin,owner=owner,reader=reader,event=original,workspace=workspace,signed=bool(writer)))+'\n'); js.stdin.flush()
        for line in js.stdout:
            if writer and line.startswith(('sign ', 'sign-as-relay ')):
                operation,text = line.split(' ',1)
                js.stdin.write(json.dumps(writer.sign(json.loads(text),as_relay=operation=='sign-as-relay'))+'\n');js.stdin.flush()
            elif line.strip() == 'append': js.stdin.write(event(ledger,2)+'\n'); js.stdin.flush()
            elif line.strip() == 'restart':
                stop_reader()
                added = event(ledger, 3)
                service, reader_port = serve(reader_port)
                js.stdin.write(added+'\n'); js.stdin.flush()
            elif line.strip() == 'revoke': (root/'upstream-read').write_text(secrets.token_urlsafe(36))
        if js.wait() != 0: raise RuntimeError('Real browser assertions failed')
        if writer:
            rows=ledger.query("SELECT envelope_json FROM event_rows WHERE kind='feedback.recorded'")
            assert len(rows)==1 and json.loads(rows[0]['envelope_json'])['payload']['target_event_id']==original
            print('PASS: pinned SSH relay, coordinator-sealed job, enrolled detached owner signature, lost commit reply reconciled exactly once')
        print('PASS: Observatory row → owner proxy → R12 view → selected origin mark; pane write denied, SSE restart/replay/revocation, focus restored')


if __name__ == '__main__':
    if sys.argv[1:2] == ['--fixture-reader']:
        root = Path(sys.argv[3])
        with make_server('127.0.0.1', int(sys.argv[2]), root/'ledger.sqlite', root/'upstream-read') as service:
            service.poll_interval = .05
            print(service.server_port, flush=True)
            service.serve_forever()
    else:
        run()
