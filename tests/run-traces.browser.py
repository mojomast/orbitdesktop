"""Disposable full-server acceptance: actual fake-Hermes callback -> SQLite -> pane.

PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
 /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/run-traces.browser.py
No response interception, trace import, owner runtime, or provider request.
"""
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.error
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SESSION = 'orbit-12345678-1234-4234-9234-123456789abc'
RUN = 'run_123456789abcdef'


class Hermes(BaseHTTPRequestHandler):
    posts = []
    def log_message(self, *args):
        pass

    def reply(self, body, status=200, content_type='application/json'):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == '/v1/capabilities':
            return self.reply({'features': {'run_events_sse': True}})
        if self.path.endswith('/messages') or '/messages?' in self.path:
            return self.reply({'data': []})
        if self.path == f'/v1/runs/{RUN}':
            return self.reply({'session_id': SESSION, 'run_id': RUN, 'status': 'completed'})
        if self.path == f'/v1/runs/{RUN}/events':
            frames = [
                {'event': 'run.started', 'timestamp': 1700000000},
                {'event': 'tool.started', 'tool': 'fixture_read', 'tool_call_id': 'call-1', 'timestamp': 1700000000.1, 'arguments': 'SECRET_ARGUMENT'},
                {'event': 'tool.completed', 'tool': 'fixture_read', 'tool_call_id': 'call-1', 'timestamp': 1700000000.4, 'output': 'SECRET_OUTPUT'},
                {'event': 'run.completed', 'timestamp': 1700000001},
            ]
            return self.reply(''.join('data: '+json.dumps(e)+'\n\n' for e in frames).encode(), content_type='text/event-stream')
        self.reply({}, 404)

    def do_POST(self):
        self.posts.append(self.path)
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if self.path == '/v1/runs':
            return self.reply({'run_id': RUN, 'status': 'running'}, 202)
        self.reply({}, 404)


def main():
    gateway = ThreadingHTTPServer(('127.0.0.1', 0), Hermes)
    threading.Thread(target=gateway.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='orbit-traces-browser-', dir='/tmp/opencode') as tmp:
            root = Path(tmp)
            for name in ('server', 'src', 'contracts', 'docs', 'public', 'hermes-plugin', 'scripts'):
                shutil.copytree(ROOT/name, root/name)
            for name in ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js'):
                shutil.copy2(ROOT/name, root/name)
            (root/'node_modules').symlink_to(ROOT/'node_modules', target_is_directory=True)
            for name in ('runtime', 'home'):
                (root/name).mkdir()
            env = {'PATH': os.environ['PATH'], 'HOME': str(root/'home')}
            # Focused trace TypeScript is checked separately; parent owns the full
            # combined check while other feature agents edit the shared checkout.
            build = subprocess.run(['node', str(ROOT/'scripts/isolated_build.mjs'), '--source', str(root), '--dest', str(root/'dist'), '--allow-source-dist', '--no-typecheck'], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            assert build.returncode == 0, build.stdout
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            token = secrets.token_urlsafe(36)
            workspace = str(uuid.uuid4())
            pane = str(uuid.uuid4())
            agent_pane = str(uuid.uuid4())
            monitor = str(uuid.uuid4())
            origin = f'http://127.0.0.1:{port}'
            env.update({'PORT': str(port), 'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': str(root/'runtime'), 'ORBIT_CWD': str(root), 'ORBIT_TMUX_SOCKET': 'trace-'+secrets.token_hex(6), 'ORBIT_TMUX_CONFIG': '/dev/null', 'HERMES_API_URL': f'http://127.0.0.1:{gateway.server_port}', 'HERMES_API_KEY': 'synthetic-fixture-key'})
            log = (root/'server.log').open('w')
            server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'], cwd=root, env=env, stdout=log, stderr=log)
            try:
                for _ in range(200):
                    if server.poll() is not None:
                        raise AssertionError((root/'server.log').read_text())
                    try:
                        urllib.request.urlopen(origin, timeout=.2).close()
                        break
                    except Exception:
                        time.sleep(.1)
                else:
                    raise AssertionError('Disposable server did not start')

                def api(route, body, text=False):
                    request = urllib.request.Request(origin+route, data=json.dumps(body).encode(), headers={'Origin': origin, 'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'})
                    try:
                        raw = urllib.request.urlopen(request, timeout=10).read().decode()
                    except urllib.error.HTTPError as error:
                        raise AssertionError(f'{route}: {error.code} {error.read().decode()}') from error
                    return raw if text else json.loads(raw)

                state = {'version': 1, 'selected': monitor, 'arc': 14, 'view': 'windows', 'appearance': {'fullViewport': False}, 'monitors': [{'id': monitor, 'name': 'Trace acceptance', 'diagonal': 32, 'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 14, 'frame': {'x': 0, 'y': 0, 'width': 820, 'height': 660, 'z': 0}, 'layout': {'type': 'pane', 'pane': {'id': pane, 'kind': 'browser', 'url': 'orbit://surface/traces'}}}]}
                agent_monitor = dict(state['monitors'][0])
                agent_monitor.update({'id': str(uuid.uuid4()), 'name': 'Bound fixture agent', 'frame': {'x': 850, 'y': 0, 'width': 280, 'height': 180, 'z': 0}, 'layout': {'type': 'pane', 'pane': {'id': agent_pane, 'kind': 'agent', 'url': ''}}})
                state['monitors'].append(agent_monitor)
                api('/api/workspace', {'action': 'sync', 'workspace_id': workspace, 'base_revision': 0, 'state': state, 'operation_id': str(uuid.uuid4()), 'intent': 'Synthetic trace acceptance'})
                run_scope = {'workspace_id': workspace, 'pane_id': agent_pane, 'profile_id': 'default', 'session_id': SESSION}
                bound = api('/api/agent', {'action': 'shared_chat', **run_scope, 'initial': {'session': SESSION, 'profile_id': 'default', 'messages': []}})
                run_scope['expected_binding_revision'] = bound['state']['binding_revision']
                api('/api/agent', {'action': 'start', **run_scope, 'input': 'Synthetic local fixture'})
                stream = api('/api/agent', {'action': 'events', **run_scope, 'run_id': RUN}, text=True)
                assert 'SECRET_OUTPUT' in stream
                traces = api('/api/run-traces', {'action': 'list', 'workspace_id': workspace})['traces']
                assert len(traces) == 1 and traces[0]['status'] == 'completed', traces
                trace = traces[0]['trace_id']
                export = api('/api/run-traces', {'action': 'export', 'workspace_id': workspace, 'trace_id': trace})
                assert 'SECRET' not in json.dumps(export)
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    context = browser.new_context(viewport={'width': 1000, 'height': 800}, accept_downloads=True)
                    context.add_init_script('if(window===window.top){localStorage.setItem("orbit.workspace.id",'+json.dumps(workspace)+');localStorage.setItem("orbit.workspace.v1",'+json.dumps(json.dumps(state))+');localStorage.setItem("orbit.onboarded","true");}')
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(origin, wait_until='domcontentloaded')
                    try:
                        page.get_by_role('button', name='Skip tour', exact=True).click(timeout=3000)
                    except Exception:
                        pass
                    try:
                        page.get_by_role('button', name='Connect local host', exact=True).click(timeout=10000)
                    except Exception as error:
                        raise AssertionError({'page_errors': errors, 'body': page.locator('body').inner_text()[:1600]}) from error
                    page.get_by_role('textbox', name='Host session token').fill(token)
                    page.get_by_role('button', name='Unlock local host', exact=True).click()
                    expect(page.locator('.run-trace-pane')).to_be_visible(timeout=15000)
                    page.get_by_label('Run', exact=True).select_option(trace)
                    expect(page.locator('.run-trace-row')).to_have_count(2, timeout=15000)
                    expect(page.locator('.run-trace-waterfall')).to_contain_text('300 ms')
                    expect(page.locator('.run-trace-pane')).not_to_contain_text('SECRET')
                    page.locator('.run-trace-row').filter(has_text='fixture_read').click()
                    expect(page.locator('.run-trace-detail')).to_contain_text('call-1')
                    page.get_by_role('button', name='Share diagnostic summary', exact=True).click()
                    sharing = page.get_by_role('dialog', name='Send text to a conversation', exact=True)
                    expect(sharing).to_be_visible()
                    expect(sharing).to_contain_text('orbit.trace-diagnostic.v1')
                    expect(sharing).to_contain_text('not an authoritative execution receipt')
                    expect(sharing).to_contain_text('not wall-clock run duration')
                    expect(sharing).not_to_contain_text('SECRET')
                    sharing.get_by_role('button', name='Cancel', exact=True).click()
                    expect(sharing).not_to_be_visible()
                    with page.expect_download() as download:
                        page.get_by_role('button', name='Export JSON', exact=True).click()
                    assert download.value.suggested_filename == f'trace-{trace}.json'
                    page.reload(wait_until='domcontentloaded')
                    try:
                        page.get_by_role('button', name='Skip tour', exact=True).click(timeout=3000)
                    except Exception:
                        pass
                    # Host token is intentionally memory-only; reconnect after reload.
                    page.get_by_role('button', name='Connect local host', exact=True).click()
                    page.get_by_role('textbox', name='Host session token').fill(token)
                    page.get_by_role('button', name='Unlock local host', exact=True).click()
                    page.get_by_label('Run', exact=True).select_option(trace)
                    expect(page.locator('.run-trace-row')).to_have_count(2, timeout=15000)
                    assert not errors, errors
                    assert Hermes.posts == ['/v1/runs'], Hermes.posts
                    browser.close()
                print('PASS actual Normal callback -> local SDK/SQLite -> authenticated export -> host waterfall -> reload')
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait()
                log.close()
    finally:
        gateway.shutdown(); gateway.server_close()


if __name__ == '__main__':
    main()
