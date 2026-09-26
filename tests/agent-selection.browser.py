"""Real Orbit server/UI with two synthetic profile gateways; no model or owner data."""
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
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
calls = []
runs = {}
class Gateway(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        profile, route = self.path[1:].split('/', 1)
        assert self.headers['Authorization'] == 'Bearer fixture-' + profile
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert route == 'v1/runs', route
        assert body['session_id'] == 'shared-session', body
        assert body['input'] == 'Draft ' + profile, body
        run = 'run_fixture_' + profile
        runs[run] = {'run_id': run, 'session_id': body['session_id'], 'status': 'completed', 'output': 'New answer ' + profile}
        calls.append((profile, route))
        self.send_response(202); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'run_id': run, 'status': 'running'}).encode())
    def do_GET(self):
        profile, route = self.path[1:].split('/', 1)
        assert self.headers['Authorization'] == 'Bearer fixture-' + profile
        calls.append((profile, route))
        if route.startswith('api/sessions/shared-session/messages'):
            data = {'data': [{'role': 'user', 'content': 'Hello ' + profile}, {'role': 'assistant', 'content': 'Saved answer ' + profile}]}
        elif route == 'api/sessions/shared-session':
            data = {'id': 'shared-session', 'title': 'Saved ' + profile}
        elif route.startswith('api/sessions?'):
            data = {'data': [{'id': 'shared-session', 'title': 'Saved ' + profile}], 'has_more': False}
        elif route.startswith('v1/runs/') and route.split('/')[-1] in runs:
            data = runs[route.split('/')[-1]]
        elif route.startswith('v1/runs'):
            data = {'data': [], 'runs': []}
        elif route == 'v1/capabilities':
            data = {'features': {}}
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(data).encode())

gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
thread = threading.Thread(target=gateway.serve_forever, daemon=True); thread.start()
try:
    with tempfile.TemporaryDirectory(prefix='orbit-agent-selection-', dir='/tmp/opencode') as temporary:
        root = Path(temporary)
        for name in ('server', 'src', 'contracts', 'dist', 'docs'):
            shutil.copytree(ROOT / name, root / name)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        shutil.copy2(ROOT / 'package.json', root / 'package.json')
        for name in ('runtime', 'home', 'cwd'): (root / name).mkdir()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        token, workspace = secrets.token_urlsafe(36), str(uuid.uuid4())
        windows, panes = [str(uuid.uuid4()) for _ in range(2)], [str(uuid.uuid4()) for _ in range(2)]
        state = {'version': 1, 'selected': windows[0], 'arc': 14, 'view': 'windows', 'monitors': [
            {'id': windows[i], 'name': f'Agent {i}', 'diagonal': 32, 'aspect': '16:9', 'height': 0, 'distance': 0,
             'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19,
             'frame': {'x': i * 800, 'y': 0, 'width': 780, 'height': 950, 'z': i},
             'layout': {'type': 'pane', 'pane': {'id': panes[i], 'kind': 'agent', 'url': ''}}} for i in range(2)]}
        profiles = [{'id': name, 'label': name.title(), 'apiUrl': f'http://127.0.0.1:{gateway.server_port}/{name}', 'apiKey': 'fixture-' + name} for name in ('default', 'research')]
        env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'PORT': str(port), 'ORBIT_TOKEN': token,
               'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd'), 'HERMES_PROFILES_JSON': json.dumps(profiles)}
        with (root / 'server.log').open('w+') as log:
            server = subprocess.Popen([shutil.which('node'), '--experimental-strip-types', 'server/index.mjs'], cwd=root, env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        log.seek(0); raise RuntimeError(log.read())
                    try:
                        with urllib.request.urlopen(origin + '/api/health', timeout=1): break
                    except OSError: time.sleep(.05)
                else: raise RuntimeError('Server readiness timeout')
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
                    context = browser.new_context(viewport={'width': 1800, 'height': 1200})
                    context.add_init_script("if(window===window.top && !localStorage.getItem('orbit.workspace.id')) {localStorage.setItem('orbit.workspace.id'," + json.dumps(workspace) + ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + '));}')
                    page = context.new_page(); errors = []; catalogs = []
                    page.on('pageerror', lambda e: errors.append(str(e)))
                    def inspect_catalog(response):
                        if response.url == origin + '/api/agent' and response.status >= 400:
                            print('Agent API rejection:', response.request.post_data_json.get('action'), response.status)
                        if response.url == origin + '/api/agent' and response.request.post_data_json.get('action') == 'profiles':
                            catalogs.append(response.json())
                    page.on('response', inspect_catalog)
                    page.goto(origin, wait_until='networkidle'); page.keyboard.press('Escape')
                    page.get_by_role('button', name='Connect local host', exact=True).click()
                    page.get_by_role('textbox', name='Host session token').fill(token)
                    page.get_by_role('button', name='Unlock local host', exact=True).click()
                    expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
                    agents = [page.locator(f'article.monitor[data-monitor-id="{w}"]') for w in windows]
                    page.wait_for_function('(panes) => panes.every(id => Number.isSafeInteger(JSON.parse(sessionStorage.getItem(`orbit-hermes-chat:${id}`) || "{}").binding_revision))', arg=panes)
                    for agent, profile in zip(agents, ('default', 'research')):
                        agent.get_by_role('button', name='Load available Hermes profiles and sessions').click(force=True)
                        expect(agent.get_by_label('Profile', exact=True)).to_be_enabled()
                        agent.get_by_label('Profile', exact=True).select_option(profile)
                        expect(agent.get_by_label('Session', exact=True).locator('option[value="shared-session"]')).to_have_count(1)
                        agent.get_by_label('Session', exact=True).select_option('shared-session')
                        expect(agent.get_by_role('button', name='Apply selected profile and session')).to_be_enabled()
                        agent.get_by_role('button', name='Apply selected profile and session').click()
                        expect(agent.get_by_label('Hermes conversation', exact=True)).to_contain_text('Saved answer ' + profile)
                    for agent, profile in zip(agents, ('default', 'research')):
                        expect(agent.get_by_label('Profile', exact=True)).to_have_value(profile)
                        expect(agent.get_by_label('Hermes conversation', exact=True)).to_contain_text('Saved answer ' + profile)
                        agent.get_by_label('Message to Hermes', exact=True).fill('Draft ' + profile)
                    # Staging is not a rebind. Applying a different profile must not
                    # carry its predecessor's unsent text into the new conversation.
                    second = agents[1]
                    for profile in ('default', 'research'):
                        second.get_by_label('Profile', exact=True).select_option(profile)
                        expect(second.get_by_label('Session', exact=True).locator('option[value="shared-session"]')).to_have_count(1)
                        second.get_by_label('Session', exact=True).select_option('shared-session')
                        if profile == 'default':
                            expect(second.get_by_label('Message to Hermes', exact=True)).to_have_value('Draft research')
                            expect(second.get_by_label('Hermes conversation', exact=True)).to_contain_text('Saved answer research')
                        expect(second.get_by_role('button', name='Apply selected profile and session')).to_be_enabled()
                        second.get_by_role('button', name='Apply selected profile and session').click()
                        expect(second.get_by_label('Hermes conversation', exact=True)).to_contain_text('Saved answer ' + profile)
                        expect(second.get_by_label('Message to Hermes', exact=True)).to_have_value('' if profile == 'default' else 'Draft research')
                    page.reload(wait_until='networkidle')
                    page.get_by_role('button', name='Connect local host', exact=True).click()
                    page.get_by_role('textbox', name='Host session token').fill(token)
                    page.get_by_role('button', name='Unlock local host', exact=True).click()
                    expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
                    for agent, profile in zip(agents, ('default', 'research')):
                        expect(agent.get_by_label('Hermes conversation', exact=True)).to_contain_text('Saved answer ' + profile)
                        expect(agent.get_by_label('Message to Hermes', exact=True)).to_have_value('Draft ' + profile)
                        expect(agent.get_by_role('button', name='Send message to Hermes', exact=True)).to_be_enabled()
                        agent.get_by_role('button', name='Send message to Hermes', exact=True).click()
                        expect(agent.get_by_label('Hermes conversation', exact=True)).to_contain_text('New answer ' + profile, timeout=15000)
                    assert not errors, errors
                    assert catalogs, 'Profile catalog was never loaded'
                    assert all('apiKey' not in json.dumps(c) and 'apiUrl' not in json.dumps(c) and 'fixture-' not in json.dumps(c) for c in catalogs), catalogs
                    assert {profile for profile, route in calls if 'messages' in route} == {'default', 'research'}
                    assert {profile for profile, route in calls if route == 'v1/runs'} == {'default', 'research'}
                    capability = json.loads((root / 'runtime' / 'workspace-access' / (workspace + '.json')).read_text())['capability']
                    snapshot_request = urllib.request.Request(origin + '/api/workspace/control', data=json.dumps({'workspace_id': workspace, 'action': 'read'}).encode(), headers={'Origin': origin, 'Authorization': 'Bearer ' + capability, 'Content-Type': 'application/json'})
                    with urllib.request.urlopen(snapshot_request) as response: snapshot = json.load(response)
                    assert snapshot['observed_revision'] >= snapshot['revision'], snapshot
                    page.screenshot(path='/tmp/opencode/orbit-agent-selection.png')
                    print('PASS: two panes bind identical session IDs in different profiles, load distinct transcripts, preserve drafts/bindings on reload, and route new messages/status to the selected profile; Chromium', browser.version)
                    print('Workspace revision:', snapshot['revision'], 'observed_revision:', snapshot['observed_revision'], 'browser_applied:', snapshot['observed_revision'] >= snapshot['revision'], 'page_errors:', len(errors))
                    page.remove_listener('response', inspect_catalog)
                    context.close(); browser.close()
            finally:
                server.terminate()
                try: server.wait(timeout=10)
                except subprocess.TimeoutExpired: server.kill(); server.wait()
finally:
    gateway.shutdown(); gateway.server_close(); thread.join(timeout=5)
