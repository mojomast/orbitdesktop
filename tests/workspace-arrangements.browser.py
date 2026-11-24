"""Disposable real-server window-arrangement continuity acceptance.

Run with PLAYWRIGHT_BROWSERS_PATH pointing at the isolated Chromium install:
  python tests/workspace-arrangements.browser.py --renderer default
  python tests/workspace-arrangements.browser.py --renderer docking

The fixture starts a private server, opens two published browser panes and one
agent pane, then advances the authoritative workspace revision. The browser
panes must keep their exact documents: no reload, no navigation and no rebuilt
iframe after the layout change is acknowledged.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

from playwright.sync_api import sync_playwright
from browser_workspace import wait_for_workspace_connection
from ui_fixture import copy_ui_source

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--renderer', choices=('default', 'docking'), required=True)
parser.add_argument('--pty', action='store_true', help='verify a private tmux shell through a layout change')
args = parser.parse_args()
if args.pty and (not shutil.which('tmux') or 'ORBIT_TMUX_SOCKET' not in (ROOT / 'server/local-host.mjs').read_text()):
    parser.error('--pty requires tmux and private socket override support; this is not a passing skip')

def api(origin, token, workspace, route, action, **fields):
    request = urllib.request.Request(origin + route,
        data=json.dumps({'workspace_id': workspace, 'action': action, **fields}).encode(),
        headers={'Origin': origin, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)

with tempfile.TemporaryDirectory(prefix='orbit-arrangements-', dir='/tmp/opencode') as temporary:
    root = Path(temporary)
    copy_ui_source(ROOT, root)
    for directory in ('server', 'contracts', 'docs', 'scripts', 'public'):
        shutil.copytree(ROOT / directory, root / directory)
    for name in ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js'):
        shutil.copy2(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    for directory in ('runtime', 'home', 'cwd', 'tmux', 'fixture'):
        (root / directory).mkdir()
    shutil.copy2(ROOT / 'tests/fixtures/runtime-continuity.html', root / 'fixture/index.html')
    env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'npm_config_cache': str(root / '.npm')}
    published = json.loads(subprocess.check_output([shutil.which('python3'), str(ROOT / 'scripts/plugin_publish.py'), str(root / 'fixture'),
        '--id', 'arrangement-continuity', '--version', '1.0.0', '--title', 'Arrangement continuity', '--runtime', str(root / 'runtime')], cwd=root, env=env))
    subprocess.run([shutil.which('node'), str(ROOT / 'scripts/isolated_build.mjs'), '--source', str(root), '--dest', str(root / 'dist'), '--allow-source-dist'], cwd=root, env=env, check=True)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    token, workspace = secrets.token_urlsafe(36), str(uuid.uuid4())
    windows = [str(uuid.uuid4()) for _ in range(3 + int(args.pty))]
    panes = [str(uuid.uuid4()) for _ in windows]
    def monitor(index, kind, url):
        return {'id': windows[index], 'name': ('Agent', 'Continuity A', 'Continuity B')[index],
            'diagonal': 32, 'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19,
            'frame': {'x': 35 + index * 330, 'y': 50 + index * 25, 'width': 620, 'height': 510, 'z': index},
            'layout': {'type': 'pane', 'pane': {'id': panes[index], 'kind': kind, 'url': url}}}
    state = {'version': 1, 'selected': windows[0], 'arc': 14, 'view': 'windows',
        'monitors': [monitor(1, 'browser', published['entry']), monitor(2, 'browser', published['entry']), monitor(0, 'agent', '')]}
    if args.pty:
        terminal = monitor(0, 'terminal', '');terminal['id'] = windows[3];terminal['layout']['pane']['id'] = panes[3]
        terminal['name'] = 'Private continuity shell';terminal['frame']['x'] = 970;terminal['frame']['z'] = 4
        state['monitors'].append(terminal)
    server_env = {**env, 'PORT': str(port), 'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': str(root / 'runtime'),
        'ORBIT_CWD': str(root / 'cwd'), 'ORBIT_TMUX_SOCKET': 'arrangement-' + secrets.token_hex(12),
        'ORBIT_TMUX_CONFIG': '/dev/null', 'TMUX_TMPDIR': str(root / 'tmux')}
    def start_server():
        process = subprocess.Popen([shutil.which('node'), '--experimental-strip-types', 'server/index.mjs'],
            cwd=root, env=server_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(200):
            if process.poll() is not None: raise RuntimeError('Disposable server exited')
            try:
                urllib.request.urlopen(origin + '/api/health', timeout=1).close()
                return process
            except OSError: time.sleep(.05)
        raise RuntimeError('Disposable server startup timed out')
    server = start_server()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1600, 'height': 1000})
            context.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id'," + json.dumps(workspace) + ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));}")
            page = context.new_page()
            errors, navigations = [], []
            terminal_sockets, terminal_data = [], []
            def on_socket(ws):
                if ws.url.endswith('/api/terminal'):
                    terminal_sockets.append(ws)
                    ws.on('framereceived', lambda payload: terminal_data.append(json.loads(payload)))
            page.on('websocket', on_socket)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('framenavigated', lambda frame: navigations.append(frame.url) if frame != page.main_frame else None)
            page.goto(origin + ('/?renderer=docking' if args.renderer == 'docking' else '/'))
            if args.renderer == 'docking': page.wait_for_function("() => document.documentElement.dataset.dockingRenderer === 'docking'")
            assert page.evaluate("typeof Element.prototype.moveBefore === 'function'"), 'Native moveBefore required for this continuity gate'
            page.keyboard.press('Escape')
            page.get_by_role('button', name='Connect local host', exact=True).click()
            page.get_by_role('textbox', name='Host session token').fill(token)
            page.get_by_role('button', name='Unlock local host', exact=True).click()
            wait_for_workspace_connection(page)
            page.wait_for_function('ids => ids.every(id => !!document.querySelector(`.pane[data-pane-id="${id}"] iframe`))',arg=panes[1:3],timeout=15000)
            for i in (1, 2):
                page.frame_locator(f'.pane[data-pane-id="{panes[i]}"] iframe').locator('#draft').fill(f'arrangement-draft-{i}')
            page.evaluate("ids => {window.__arrangementNodes=Object.fromEntries(ids.map(id=>{const pane=document.querySelector(`.pane[data-pane-id=\"${id}\"]`),frame=pane.querySelector('iframe');return [id,{pane,frame,contentWindow:frame.contentWindow}]}));}", panes[1:3])
            nonce = {i: page.frame_locator(f'.pane[data-pane-id="{panes[i]}"] iframe').locator('#document-nonce').inner_text() for i in (1, 2)}
            navigation_count = len(navigations)
            def workspace_read():
                code, result = api(origin, token, workspace, '/api/workspace', 'read')
                assert code == 200, result
                return result
            def continuity(label):
                assert not errors, (label, errors)
                assert len(navigations) == navigation_count, (label, navigations[navigation_count:])
                for i in (1, 2):
                    assert page.evaluate("id=>{const old=window.__arrangementNodes[id],pane=document.querySelector(`.pane[data-pane-id=\"${id}\"]`);return !!pane&&pane.isConnected&&pane===old.pane&&pane.querySelector('iframe')===old.frame&&old.frame.contentWindow===old.contentWindow}", panes[i]), (label, panes[i])
                    frame = page.frame_locator(f'.pane[data-pane-id="{panes[i]}"] iframe')
                    assert frame.locator('#document-nonce').inner_text() == nonce[i], label
                    assert frame.locator('#draft').input_value() == f'arrangement-draft-{i}', label
                if args.pty:
                    assert page.evaluate('id => window.__terminalNode===document.querySelector(`.pane[data-pane-id="${id}"]`) && window.__terminalNode.isConnected',panes[3]),label
            baseline = workspace_read()
            changed = json.loads(json.dumps(baseline['state']))
            changed['selected'] = windows[1]
            code, response = api(origin, token, workspace, '/api/workspace', 'sync', base_revision=baseline['revision'],
                state=changed, operation_id=str(uuid.uuid4()), intent='Synthetic layout continuity check')
            assert code == 200, response
            page.wait_for_function("id => JSON.parse(localStorage.getItem('orbit.workspace.v1')).selected === id", arg=windows[1], timeout=15000)
            continuity('layout sync')
            # Restart only this disposable server; the browser document and its
            # panes must survive the service round trip.
            server.terminate(); server.wait(timeout=10)
            server = start_server()
            current = workspace_read()
            continuity('service restart')
            print(json.dumps({'renderer':args.renderer,'pty':args.pty,'revision':current['revision'],'continuity':'pass'}))
            context.close(); browser.close()
    finally:
        if server.poll() is None:
            server.terminate(); server.wait(timeout=10)
        if shutil.which('tmux'):
            subprocess.run(['tmux', '-L', server_env['ORBIT_TMUX_SOCKET'], 'kill-server'], env=server_env, capture_output=True)
