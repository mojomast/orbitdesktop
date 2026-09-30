"""Disposable real-server arrangement UI, continuity, CAS and durable undo acceptance.

Run with PLAYWRIGHT_BROWSERS_PATH pointing at the isolated Chromium install:
  python tests/workspace-arrangements.browser.py --renderer default
  python tests/workspace-arrangements.browser.py --renderer docking
The restart/undo gate requires durable recipe state from the backend increment.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--renderer', choices=('default', 'docking'), required=True)
parser.add_argument('--pty', action='store_true', help='verify a private tmux shell through arrangement transitions')
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
    for directory in ('server', 'src', 'contracts', 'docs', 'scripts', 'public'):
        shutil.copytree(ROOT / directory, root / directory)
    for name in ('index.html', 'package.json', 'tsconfig.json', 'vite.config.js'):
        shutil.copy2(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    for directory in ('runtime', 'home', 'cwd', 'tmux', 'fixture', 'project'):
        (root / directory).mkdir()
    (root / 'project' / 'readme.txt').write_text('Synthetic arrangement fixture\n')
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
        return {'id': windows[index], 'name': ('Workbench agent', 'Continuity A', 'Continuity B')[index],
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
            context.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.experimental.v1','{\"version\":1,\"workbench\":true}');localStorage.setItem('orbit.workspace.id'," + json.dumps(workspace) + ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));}")
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
            expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
            page.wait_for_function('ids => ids.every(id => !!document.querySelector(`.pane[data-pane-id="${id}"] iframe`))',arg=panes[1:3],timeout=15000)
            for i in (1, 2):
                page.frame_locator(f'.pane[data-pane-id="{panes[i]}"] iframe').locator('#draft').fill(f'arrangement-draft-{i}')
            page.evaluate("ids => {window.__arrangementNodes=Object.fromEntries(ids.map(id=>{const pane=document.querySelector(`.pane[data-pane-id=\"${id}\"]`),frame=pane.querySelector('iframe');return [id,{pane,frame,contentWindow:frame.contentWindow}]}));}", panes[1:3])
            nonce = {i: page.frame_locator(f'.pane[data-pane-id="{panes[i]}"] iframe').locator('#document-nonce').inner_text() for i in (1, 2)}
            navigation_count = len(navigations)
            phases=[]
            def observed(revision, label, started_at):
                deadline=time.perf_counter()+20
                while time.perf_counter()<deadline:
                    read=workspace_read()
                    if read.get('observed_revision',0)>=revision:
                        phases.append({'step':label,'apply_request_to_observed_ms':round((time.perf_counter()-started_at)*1000,1),'revision':revision})
                        return
                    time.sleep(.1)
                raise AssertionError(f'{label}: browser did not acknowledge revision {revision}')
            shell_pid=None
            if args.pty:
                shell=page.locator(f'.pane[data-pane-id="{panes[3]}"]')
                shell.get_by_role('button', name='Connect to local host shell').evaluate('(button) => button.click()')
                expect(shell.locator('.connection-state')).to_contain_text('LIVE SHELL', timeout=15000)
                assert len(terminal_sockets)==1, terminal_sockets
                def fresh_shell(label):
                    marker='ARRANGEMENT_'+secrets.token_hex(6).upper()
                    old_frames=len(terminal_data)
                    subprocess.run(['tmux','-L',server_env['ORBIT_TMUX_SOCKET'],'send-keys','-t','pane-'+panes[3],
                        f'printf "{marker}_%s_%s\\n" "$ORBIT_ARRANGEMENT_VAR" "$$"','C-m'],env=server_env,check=True,capture_output=True,timeout=5)
                    deadline=time.perf_counter()+10
                    while time.perf_counter()<deadline:
                        output=''.join(item.get('data','') for item in terminal_data[old_frames:] if item.get('type')=='data')
                        match=re.search(marker+r'_retained_(\d+)',output)
                        if match:return match.group(1)
                        page.wait_for_timeout(100)
                    raise AssertionError(f'{label}: no new terminal WebSocket output for {marker}')
                def reconnect_shell(label):
                    pane=page.locator(f'.pane[data-pane-id="{panes[3]}"]')
                    for _ in range(50):
                        if pane.locator('.connection-state').count() and 'LIVE SHELL' in pane.locator('.connection-state').inner_text():break
                        page.evaluate('id => {for(const node of document.querySelectorAll(`.pane[data-pane-id="${id}"]`)){const button=node.querySelector("button[aria-label=\\"Connect to local host shell\\"]");if(button && !button.disabled){button.click();break;}}}',panes[3])
                        page.wait_for_timeout(100)
                    expect(pane.locator('.connection-state')).to_contain_text('LIVE SHELL',timeout=15000)
                    assert fresh_shell(label)==shell_pid,f'{label}: private tmux shell PID changed'
                    return len(terminal_sockets)
                subprocess.run(['tmux','-L',server_env['ORBIT_TMUX_SOCKET'],'send-keys','-t','pane-'+panes[3],
                    'export ORBIT_ARRANGEMENT_VAR=retained','C-m'],env=server_env,check=True,capture_output=True,timeout=5)
                shell_pid=fresh_shell('initial')
                page.evaluate('id => window.__terminalNode=document.querySelector(`.pane[data-pane-id="${id}"]`)',panes[3])
            expected_terminal_sockets=len(terminal_sockets)
            def continuity(label):
                assert not errors, (label, errors)
                assert len(navigations) == navigation_count, (label, navigations[navigation_count:])
                for i in (1, 2):
                    assert page.evaluate("id=>{const old=window.__arrangementNodes[id],pane=document.querySelector(`.pane[data-pane-id=\"${id}\"]`);return !!pane&&pane.isConnected&&pane===old.pane&&pane.querySelector('iframe')===old.frame&&old.frame.contentWindow===old.contentWindow}", panes[i]), (label, panes[i])
                    frame = page.frame_locator(f'.pane[data-pane-id="{panes[i]}"] iframe')
                    assert frame.locator('#document-nonce').inner_text() == nonce[i], label
                    assert frame.locator('#draft').input_value() == f'arrangement-draft-{i}', label
                if args.pty:
                    assert len(terminal_sockets)==expected_terminal_sockets, (label,len(terminal_sockets),expected_terminal_sockets)
                    assert page.evaluate('id => window.__terminalNode===document.querySelector(`.pane[data-pane-id="${id}"]`) && window.__terminalNode.isConnected',panes[3]),label
                    assert fresh_shell(label)==shell_pid, f'{label}: shell PID changed'
            def workspace_read():
                code, result = api(origin, token, workspace, '/api/workspace', 'read')
                assert code == 200, result
                return result
            # Registration and bindings use real owner routes; no model is dispatched.
            workspace_read()
            code, registration = api(origin, token, workspace, '/api/workbench', 'register_preview', root=str(root / 'project'), name='Fixture project')
            assert code == 200, registration
            code, registered = api(origin, token, workspace, '/api/workbench', 'register_commit', approval_id=registration['approval_id'])
            assert code == 200, registered
            project = registered['project']['id']
            code, linked = api(origin, token, workspace, '/api/workbench', 'link_pane', project_id=project, pane_id=panes[0], base_revision=workspace_read()['revision'])
            assert code == 200, linked
            def open_inspector():
                if not page.get_by_role('button', name='Project Workbench', exact=True).is_visible():
                    page.get_by_role('button', name='Open orbit menu').click()
                page.get_by_role('button', name='Project Workbench', exact=True).click()
                dialog = page.locator('dialog.project-workbench-dialog')
                dialog.get_by_role('button', name='Open project Fixture project').click()
                expect(dialog.locator('.workbench-arrangements')).to_be_visible(timeout=15000)
                return dialog
            dialog = open_inspector()
            card = dialog.locator('.workbench-arrangements')
            before = workspace_read()
            card.get_by_role('button', name='Preview Implement arrangement').click()
            apply_button = card.get_by_role('button', name='Apply the exact preview under workspace revision check')
            expect(apply_button).to_be_enabled()
            card.get_by_role('button', name='Discard the arrangement preview without changing the workspace').click()
            expect(apply_button).to_be_disabled()
            assert workspace_read()['revision'] == before['revision']
            # Create a stale preview by advancing the authoritative revision independently.
            card.get_by_role('button', name='Preview Implement arrangement').click()
            expect(apply_button).to_be_enabled()
            current = workspace_read()
            changed_state = json.loads(json.dumps(current['state'])); changed_state['selected'] = windows[1]
            code, changed = api(origin, token, workspace, '/api/workspace', 'sync', base_revision=current['revision'],
                state=changed_state, operation_id=str(uuid.uuid4()), intent='Synthetic owner edit invalidating arrangement preview')
            assert code == 200, changed
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_apply') as pending:
                apply_button.click()
            assert pending.value.status != 200, pending.value.json()
            expect(apply_button).to_be_disabled()
            continuity('stale preview')
            # Re-preview; apply a real reorder and preserve both iframe documents.
            baseline = workspace_read()
            card.get_by_role('button', name='Preview Investigate arrangement').click()
            expect(apply_button).to_be_enabled()
            started=time.perf_counter()
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_apply') as pending:
                apply_button.click()
            assert pending.value.status == 200, pending.value.json()
            applied = pending.value.json()['workspace']['revision']
            observed(applied,'first_project_apply',started)
            expect(card.locator('.workbench-arrangement-status')).to_contain_text('acknowledged', timeout=20000)
            continuity('apply')
            # The arrangement surface is visible in the Inspector and the pane.
            dialog.get_by_role('button', name='Close project workbench').click()
            agent = page.locator(f'.pane[data-pane-id="{panes[0]}"]')
            agent.get_by_role('button', name='Workbench Hermes mode', exact=True).evaluate('(button) => button.click()')
            choice = agent.get_by_label('Workbench project', exact=True)
            expect(choice.locator(f'option[value="{project}"]')).to_have_count(1, timeout=15000)
            choice.evaluate('(select, value) => {select.value=value;select.dispatchEvent(new Event("change",{bubbles:true}));}', project)
            expect(agent.locator('.pane-workbench-arrangements .workbench-arrangements')).to_have_count(1, timeout=15000)
            # Restart only this disposable server, retaining its runtime and browser document.
            server.terminate(); server.wait(timeout=10)
            server = start_server()
            if args.pty:
                expected_terminal_sockets=reconnect_shell('first service restart')
            dialog = open_inspector(); card = dialog.locator('.workbench-arrangements')
            card.get_by_role('button', name='Preview return arrangement').click()
            apply_button = card.get_by_role('button', name='Apply the exact preview under workspace revision check')
            expect(apply_button).to_be_enabled(timeout=15000)
            started=time.perf_counter()
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_apply') as pending:
                apply_button.click()
            assert pending.value.status == 200, pending.value.json()
            returned = workspace_read()
            observed(returned['revision'],'first_project_return',started)
            assert returned['revision'] == applied + 1
            assert returned['state'] == baseline['state'] and returned.get('placement') == baseline.get('placement')
            continuity('restart and undo')
            # A trusted Review pane is created/bound by the real owner UI. Preview
            # its geometry using the actual renderer surface at a narrow viewport.
            card.get_by_role('button', name='Open the owner-bound candidate review pane for this project').click()
            expect(dialog).not_to_be_visible(timeout=15000)
            dialog = open_inspector(); card = dialog.locator('.workbench-arrangements')
            page.set_viewport_size({'width': 760, 'height': 700})
            surface = '.docking-root' if args.renderer == 'docking' else '.desktop-host'
            size = page.locator(surface).evaluate('(host) => {const box=host.getBoundingClientRect();return {width:Math.floor(box.width),height:Math.floor(box.height)}}')
            assert size['width'] >= 280 and size['height'] >= 180, size
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_preview') as pending:
                card.get_by_role('button', name='Preview Review arrangement').click()
            review_request = pending.value.request.post_data_json
            assert review_request['width'] == size['width'] and review_request['height'] == size['height'], (review_request, size)
            assert pending.value.status == 200, pending.value.json()
            review_preview = pending.value.json()
            assert review_preview['semantic_diff'] and review_preview['renderer'], review_preview
            expect(card.locator('.workbench-arrangement-diff')).to_contain_text(review_preview['semantic_diff'][0]['summary'])
            expect(card.get_by_role('button', name='Apply the exact preview under workspace revision check')).to_be_enabled()
            continuity('review measured preview')
            card.get_by_role('button', name='Discard the arrangement preview without changing the workspace').click()
            # Two live preview bindings demand an explicit choice, while an
            # unbound role is shown rather than being silently invented.
            for pane_id in panes[1:3]:
                code, linked = api(origin, token, workspace, '/api/workbench', 'link_pane',
                    project_id=project, pane_id=pane_id, base_revision=workspace_read()['revision'])
                assert code == 200, linked
            dialog.get_by_role('button', name='Close project workbench').click()
            dialog = open_inspector(); card = dialog.locator('.workbench-arrangements')
            card.get_by_role('button',name='Preview Investigate arrangement').click()
            expect(card.locator('.workbench-arrangement-status')).to_contain_text('Choose one bound pane for preview')
            card.get_by_label('Binding for preview',exact=True).select_option(index=1)
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action')=='recipe_preview') as pending:
                card.get_by_role('button',name='Preview Investigate arrangement').click()
            assert pending.value.status==200,pending.value.json()
            assert pending.value.request.post_data_json['role_choices']['preview']
            card.get_by_role('button',name='Discard the arrangement preview without changing the workspace').click()
            card.locator('.workbench-arrangement-saved summary').click()
            card.get_by_label('Portable recipe name').fill('Portable investigation')
            card.get_by_label('Include primary_agent').check()
            card.get_by_label('Include preview').check()
            card.get_by_label('Include active_terminal').check()
            card.get_by_label('Portable recipe layout').select_option('columns')
            card.get_by_label('Portable recipe renderer').select_option('docking' if args.renderer == 'docking' else 'windows')
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_save') as pending:
                card.get_by_role('button', name='Save only role priorities, layout type and renderer; never current window frames').click()
            assert pending.value.status == 200, pending.value.json()
            recipe_id = pending.value.json()['recipe']['id']
            expect(card.get_by_label('Saved portable recipe')).to_have_value(recipe_id, timeout=15000)
            expect(card.locator('.workbench-arrangement-unbound')).to_contain_text('active terminal')
            card.get_by_role('button', name='Resolve current project bindings and preview this portable recipe').click()
            expect(card.locator('.workbench-arrangement-status')).to_contain_text('Choose one bound pane for preview')
            chosen = card.get_by_label('Binding for preview', exact=True)
            chosen.select_option(index=1)
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_preview') as pending:
                card.get_by_role('button', name='Resolve current project bindings and preview this portable recipe').click()
            named_preview = pending.value.json()
            assert pending.value.status == 200 and named_preview['recipe_id'] == recipe_id, named_preview
            assert named_preview['geometry'] == 'applied' and 'active_terminal' in named_preview['unbound'], (named_preview, pending.value.request.post_data_json)
            assert pending.value.request.post_data_json['role_choices']['preview'] == chosen.input_value()
            continuity('named measured preview')
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_apply') as pending:
                card.get_by_role('button', name='Apply the exact preview under workspace revision check').click()
            assert pending.value.status == 200, pending.value.json()
            named_apply_request = pending.value.request.post_data_json
            continuity('named measured apply')
            card.get_by_label('Portable recipe name').fill('Portable investigation updated')
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_save') as pending:
                card.get_by_role('button', name='Save only role priorities, layout type and renderer; never current window frames').click()
            assert pending.value.status == 200 and pending.value.json()['recipe']['id'] == recipe_id, pending.value.json()
            assert pending.value.request.post_data_json['expected_version'] == 1
            edited_save_request = pending.value.request.post_data_json
            expect(card.get_by_label('Saved portable recipe')).to_have_value(recipe_id, timeout=15000)
            # Browser reload is a separate recovery boundary: assert durable
            # recipes/committed proposals, not pre-reload iframe document identity.
            page.evaluate("""records => {
              const scope=records.save.workspace_id+':'+records.save.project_id;
              sessionStorage.setItem('orbit.arrangement.save:'+scope,JSON.stringify(records.save));
              sessionStorage.setItem('orbit.arrangement.apply:'+scope,JSON.stringify(records.apply));
            }""", {'save': edited_save_request, 'apply': named_apply_request})
            page.reload()
            page.keyboard.press('Escape')
            page.get_by_role('button', name='Connect local host', exact=True).click()
            page.get_by_role('textbox', name='Host session token').fill(token)
            page.get_by_role('button', name='Unlock local host', exact=True).click()
            expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
            # A browser reload intentionally replaces documents. Establish a
            # new in-document continuity baseline for subsequent recipe moves.
            for i in (1,2):
                page.frame_locator(f'.pane[data-pane-id="{panes[i]}"] iframe').locator('#draft').fill(f'arrangement-draft-{i}')
            page.evaluate('ids => {window.__arrangementNodes=Object.fromEntries(ids.map(id=>{const pane=document.querySelector(`.pane[data-pane-id="${id}"]`),frame=pane.querySelector("iframe");return [id,{pane,frame,contentWindow:frame.contentWindow}]}));}',panes[1:3])
            nonce={i:page.frame_locator(f'.pane[data-pane-id="{panes[i]}"] iframe').locator('#document-nonce').inner_text() for i in (1,2)}
            navigation_count=len(navigations)
            if args.pty:
                expected_terminal_sockets=reconnect_shell('browser reload')
                page.evaluate('id => window.__terminalNode=document.querySelector(`.pane[data-pane-id="${id}"]`)',panes[3])
            dialog = open_inspector(); card = dialog.locator('.workbench-arrangements')
            expect(card.get_by_role('button', name='Replay the same durable save operation key before considering any new save')).to_be_visible(timeout=15000)
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_save') as pending:
                card.get_by_role('button', name='Replay the same durable save operation key before considering any new save').click()
            assert pending.value.status == 200 and pending.value.json()['idempotent'] is True, pending.value.json()
            assert pending.value.request.post_data_json == edited_save_request
            page.wait_for_function("scope => !sessionStorage.getItem('orbit.arrangement.apply:'+scope) && !sessionStorage.getItem('orbit.arrangement.save:'+scope)", arg=workspace+':'+project)
            expect(card.get_by_label('Saved portable recipe').locator(f'option[value="{recipe_id}"]')).to_have_count(1, timeout=15000)
            card.locator('.workbench-arrangement-proposals summary').click()
            expect(card.get_by_label('Recorded arrangement proposal').locator('option')).not_to_have_count(0)
            card.get_by_role('button', name='Read the durable exact proposal for the selected record').click()
            expect(card.locator('.workbench-arrangement-proposal-details')).to_contain_text('Browser rendering: Not established')
            # The portable recipe is shared across this workspace. Reuse it for
            # another registered project with fresh panes and live bindings.
            second_root = root / 'second-project';second_root.mkdir();(second_root / 'readme.txt').write_text('Independent project\n')
            code, registration2 = api(origin, token, workspace, '/api/workbench', 'register_preview', root=str(second_root), name='Second project')
            assert code == 200, registration2
            code, second = api(origin, token, workspace, '/api/workbench', 'register_commit', approval_id=registration2['approval_id'])
            assert code == 200, second
            project2 = second['project']['id']
            second_panes = [str(uuid.uuid4()), str(uuid.uuid4())]
            second_window_ids=[]
            second_state = json.loads(json.dumps(workspace_read()['state']))
            for index, kind in enumerate(('agent', 'browser')):
                added = monitor(index, kind, '' if kind == 'agent' else published['entry'])
                added['id'] = str(uuid.uuid4());added['layout']['pane']['id'] = second_panes[index]
                second_window_ids.append(added['id'])
                added['name'] = 'Second project ' + kind
                second_state['monitors'].append(added)
            current = workspace_read()
            code, added = api(origin, token, workspace, '/api/workspace', 'sync', base_revision=current['revision'],
                state=second_state, operation_id=str(uuid.uuid4()), intent='Add disposable panes for independent second project')
            assert code == 200, added
            for pane_id in second_panes:
                code, bound = api(origin, token, workspace, '/api/workbench', 'link_pane',
                    project_id=project2, pane_id=pane_id, base_revision=workspace_read()['revision'])
                assert code == 200, bound
            dialog.get_by_role('button', name='Close project workbench').click()
            dialog = open_inspector()
            dialog.get_by_role('button', name='Open project Second project').click()
            card = dialog.locator('.workbench-arrangements')
            expect(dialog.locator('.workbench-project-meta')).to_contain_text('Second project')
            expect(dialog.locator('.workbench-execution')).to_contain_text('Workflow ready', timeout=15000)
            expect(card.get_by_label('Saved portable recipe').locator(f'option[value="{recipe_id}"]')).to_have_count(1, timeout=15000)
            card.get_by_label('Saved portable recipe').select_option(recipe_id)
            expect(card.get_by_label('Binding for preview', exact=True)).to_have_count(0)
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_preview') as pending:
                card.get_by_role('button', name='Resolve current project bindings and preview this portable recipe').click()
            assert pending.value.status == 200, pending.value.json()
            assert pending.value.json()['recipe_id'] == recipe_id
            assert pending.value.json()['recipe_project_id'] == project
            assert pending.value.json()['geometry'] == 'applied'
            second_baseline=workspace_read()
            # Preview is durable without a commit: restart the disposable service
            # while this exact proposal is pending, then apply it through the UI.
            second_preview_id=pending.value.json()['preview_id']
            server.terminate();server.wait(timeout=10);server=start_server()
            code, pending_record=api(origin,token,workspace,'/api/workbench/workflow','proposal_get',project_id=project2,proposal_id=second_preview_id)
            assert code==200 and pending_record['proposal']['status']=='previewed',pending_record
            if args.pty:
                expected_terminal_sockets=reconnect_shell('pending-preview service restart')
            navigation_count=len(navigations)
            started=time.perf_counter()
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_apply') as pending:
                card.get_by_role('button', name='Apply the exact preview under workspace revision check').click()
            assert pending.value.status==200,pending.value.json()
            second_applied=workspace_read()
            observed(second_applied['revision'],'second_project_apply_after_restart',started)
            assert second_applied['revision']==second_baseline['revision']+1
            first_before={m['id']:m for m in second_baseline['state']['monitors'] if m['id'] not in second_window_ids}
            first_after={m['id']:m for m in second_applied['state']['monitors'] if m['id'] not in second_window_ids}
            assert first_after==first_before,'second-project recipe changed unrelated window content or frames'
            before_floats=(second_baseline.get('placement') or {}).get('floats',[])
            after_floats=(second_applied.get('placement') or {}).get('floats',[])
            for item in before_floats:
                if not any(window in second_window_ids for window in item['windows']):
                    assert item in after_floats,'second-project recipe changed an unrelated Docking float'
            continuity('second project apply after pending-preview restart')
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action')=='recipe_preview') as pending:
                card.get_by_role('button',name='Preview return arrangement').click()
            assert pending.value.status==200,pending.value.json()
            started=time.perf_counter()
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action')=='recipe_apply') as pending:
                card.get_by_role('button',name='Apply the exact preview under workspace revision check').click()
            assert pending.value.status==200,pending.value.json()
            second_returned=workspace_read()
            observed(second_returned['revision'],'second_project_return',started)
            assert second_returned['state']==second_baseline['state'] and second_returned.get('placement')==second_baseline.get('placement')
            continuity('second project exact return')
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_preview') as pending:
                card.get_by_role('button', name='Resolve current project bindings and preview this portable recipe').click()
            assert pending.value.status==200,pending.value.json()
            # The preview's measured viewport is part of its commit identity.
            # Resizing before first apply must require a new preview, with no
            # workspace revision change and no recipe_apply request.
            before_resize = workspace_read()['revision']
            page.set_viewport_size({'width': 1000, 'height': 800})
            card.get_by_role('button', name='Apply the exact preview under workspace revision check').click()
            expect(card.locator('.workbench-arrangement-status')).to_contain_text('Preview again before applying')
            assert workspace_read()['revision'] == before_resize
            # Existing browser-local layouts are only imported as role order.
            # Create the local layout through the real switcher so its in-memory
            # collection cannot overwrite an out-of-band localStorage fixture.
            dialog.get_by_role('button',name='Close project workbench').click()
            before_local=workspace_read()
            reversed_state=json.loads(json.dumps(before_local['state']))
            reversed_state['monitors'].reverse()
            code,reordered=api(origin,token,workspace,'/api/workspace','sync',base_revision=before_local['revision'],
                state=reversed_state,operation_id=str(uuid.uuid4()),intent='Synthetic local-layout order for portable import')
            assert code==200,reordered
            page.wait_for_function("ids => JSON.stringify(JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors.map(m=>m.id))===JSON.stringify(ids)",arg=[m['id'] for m in reversed_state['monitors']])
            page.get_by_role('button',name='Choose workspace layout').click()
            page.get_by_label('Layout name').fill('Local old layout')
            page.get_by_role('button',name='Create layout from current').click()
            page.get_by_role('button',name='Close workspace layouts').click()
            dialog=open_inspector();dialog.get_by_role('button',name='Open project Second project').click()
            card=dialog.locator('.workbench-arrangements')
            local_before = page.evaluate("() => localStorage.getItem('orbit.layouts.'+localStorage.getItem('orbit.workspace.id'))")
            local_layout=next(item for item in json.loads(local_before)['layouts'] if item['name']=='Local old layout')
            local_id=local_layout['id']
            card.locator('.workbench-arrangement-import summary').click()
            card.get_by_role('button',name='Read this browser’s saved layouts').click()
            expect(card.get_by_label('Local saved layout to import').locator(f'option[value="{local_id}"]')).to_have_count(1)
            card.get_by_label('Local saved layout to import').select_option(local_id)
            card.get_by_role('button', name='Convert one selected local layout to portable role-order constraints without saving').click()
            expect(card.locator('.workbench-arrangement-import-preview')).to_contain_text('frame pixel coordinates')
            expect(card.locator('.workbench-arrangement-import-preview')).to_contain_text('does not reproduce the legacy layout geometry')
            card.get_by_role('button', name='Fill the portable recipe editor; original local layout stays unchanged').click()
            expect(card.get_by_label('Portable recipe name')).to_have_value('Local old layout')
            if args.renderer == 'docking': card.get_by_label('Portable recipe renderer').select_option('docking')
            assert page.evaluate("() => localStorage.getItem('orbit.layouts.'+localStorage.getItem('orbit.workspace.id'))") == local_before
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_save') as pending:
                card.get_by_role('button', name='Save only role priorities, layout type and renderer; never current window frames').click()
            assert pending.value.status == 200, pending.value.json()
            imported_id = pending.value.json()['recipe']['id']
            assert [m['id'] for m in reversed_state['monitors']].index(second_window_ids[1]) < [m['id'] for m in reversed_state['monitors']].index(second_window_ids[0])
            assert pending.value.request.post_data_json['roles'] == ['preview','primary_agent'], pending.value.request.post_data_json
            expect(card.get_by_label('Saved portable recipe')).to_have_value(imported_id, timeout=15000)
            assert page.evaluate("() => localStorage.getItem('orbit.layouts.'+localStorage.getItem('orbit.workspace.id'))") == local_before
            marker = page.evaluate("() => JSON.parse(localStorage.getItem('orbit.arrangement.imports:'+localStorage.getItem('orbit.workspace.id'))||'{}')")
            assert marker[local_id]['recipe_id'] == imported_id, marker
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action') == 'recipe_preview') as pending:
                card.get_by_role('button', name='Resolve current project bindings and preview this portable recipe').click()
            assert pending.value.status == 200 and pending.value.json()['recipe_id'] == imported_id, pending.value.json()
            imported_pending_id=pending.value.json()['preview_id']
            # A new, independent browser context has no inherited localStorage or
            # sessionStorage. It must retrieve the shared recipe and this project's
            # pending durable proposal through authenticated UI reads.
            other=browser.new_context(viewport={'width':1000,'height':800})
            other.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id',"+json.dumps(workspace)+");}")
            other_page=other.new_page()
            other_page.goto(origin+('/?renderer=docking' if args.renderer=='docking' else '/'))
            other_page.keyboard.press('Escape')
            other_page.get_by_role('button',name='Connect local host',exact=True).click()
            other_page.get_by_role('textbox',name='Host session token').fill(token)
            other_page.get_by_role('button',name='Unlock local host',exact=True).click()
            expect(other_page.locator('.saved')).to_contain_text('Workspace connected',timeout=15000)
            other_page.get_by_role('button',name='Open orbit menu').click()
            other_page.get_by_role('button',name='Project Workbench',exact=True).click()
            other_dialog=other_page.locator('dialog.project-workbench-dialog')
            other_dialog.get_by_role('button',name='Open project Second project').click()
            other_card=other_dialog.locator('.workbench-arrangements')
            expect(other_card.get_by_label('Saved portable recipe').locator(f'option[value="{imported_id}"]')).to_have_count(1,timeout=15000)
            other_card.locator('.workbench-arrangement-proposals summary').click()
            expect(other_card.get_by_label('Recorded arrangement proposal').locator(f'option[value="{imported_pending_id}"]')).to_have_count(1,timeout=15000)
            other_card.get_by_label('Recorded arrangement proposal').select_option(imported_pending_id)
            other_card.get_by_role('button',name='Read the durable exact proposal for the selected record').click()
            expect(other_card.locator('.workbench-arrangement-proposal-details')).to_contain_text('Status: previewed')
            expect(other_card.get_by_role('button',name='Load the exact persisted preview for a deliberate apply or cancel')).to_be_visible()
            other.close()
            card.get_by_label('Saved portable recipe').select_option(recipe_id)
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action')=='recipe_preview') as pending:
                card.get_by_role('button',name='Resolve current project bindings and preview this portable recipe').click()
            assert pending.value.status==200 and pending.value.json()['changed'] is True,pending.value.json()
            screenshots=[]
            def shot(label,size):
                page.set_viewport_size(size)
                if label=='semantic-preview':
                    card.locator('.workbench-arrangement-saved').evaluate('(node)=>node.open=false')
                    card.locator('.workbench-arrangement-import').evaluate('(node)=>node.open=false')
                    card.locator('.workbench-arrangement-proposals').evaluate('(node)=>node.open=false')
                    card.locator('.workbench-arrangement-details').evaluate('(node)=>node.open=false')
                    diff=card.locator('.workbench-arrangement-diff')
                    apply=card.get_by_role('button',name='Apply the exact preview under workspace revision check')
                    expect(diff).to_be_visible();expect(apply).to_be_enabled()
                    diff.scroll_into_view_if_needed();apply.scroll_into_view_if_needed()
                    for target in (diff,apply):
                        box=target.bounding_box()
                        assert box and box['y']>=0 and box['y']+box['height']<=size['height'],(label,size,box)
                else:
                    disclosure.scroll_into_view_if_needed()
                    box=disclosure.bounding_box()
                    assert box and 0<=box['y']<size['height'],(label,size,box)
                image=f"/tmp/opencode/orbit-arrangements-{args.renderer}-{label}-{size['width']}x{size['height']}.png"
                page.screenshot(path=image,mask=[page.locator('input[type=password], input[aria-label="Host session token"]')])
                screenshots.append(image)
            shot('semantic-preview',{'width':1000,'height':800})
            page.set_viewport_size({'width':520,'height':700})
            with page.expect_response(lambda response: response.url.endswith('/api/workbench/workflow') and (response.request.post_data_json or {}).get('action')=='recipe_preview') as pending:
                card.get_by_role('button',name='Resolve current project bindings and preview this portable recipe').click()
            assert pending.value.status==200,pending.value.json()
            shot('semantic-preview',{'width':520,'height':700})
            card.get_by_role('button', name='Prepare a portable Debug recipe for explicit save and preview').click()
            expect(card.get_by_label('Portable recipe name')).to_have_value('Debug')
            expect(card.locator('.workbench-arrangement-status')).to_contain_text('no arrangement has been applied')
            dialog.get_by_role('button',name='Close project workbench').click()
            page.keyboard.press('Escape')
            code, task_result = api(origin, token, workspace, '/api/workbench/execution', 'task_create',
                project_id=project, title='Review workspace arrangement', acceptance_statement='Inspect the saved portable arrangement',
                check_definition_id='host-regression', profile_id='default', session_id='fixture')
            assert code == 200 and task_result['ok'] is True, task_result
            task_id = task_result['task']['id']
            agent=page.locator(f'.pane[data-pane-id="{panes[0]}"]')
            expect(agent).to_have_count(1)
            page.set_viewport_size({'width':1000,'height':800})
            page.evaluate("id => {const monitor=document.querySelector(`.monitor[data-monitor-id=\"${id}\"]`);monitor.style.zIndex='9999';}",windows[0])
            mode=agent.get_by_role('button',name='Workbench Hermes mode',exact=True)
            if mode.get_attribute('aria-pressed')!='true':mode.evaluate('(button)=>button.click()')
            settings = agent.locator('.pane-workbench-settings')
            if settings.get_attribute('open') is None:settings.locator(':scope > summary').click()
            project_choice=agent.get_by_label('Workbench project',exact=True)
            expect(project_choice.locator(f'option[value="{project}"]')).to_have_count(1,timeout=15000)
            project_choice.evaluate('(select,value)=>{select.value=value;select.dispatchEvent(new Event("change",{bubbles:true}));}',project)
            task_choice=agent.get_by_label('Workbench task',exact=True)
            expect(task_choice.locator(f'option[value="{task_id}"]')).to_have_count(1,timeout=15000)
            task_choice.select_option(task_id)
            expect(task_choice).to_have_value(task_id)
            expect(agent.locator('.pane-workbench-arrangements-disclosure')).to_have_count(1,timeout=15000)
            changes=agent.get_by_role('tab',name='Changes workbench view',exact=True)
            changes.click()
            disclosure=agent.locator('.pane-workbench-arrangements-disclosure')
            expect(disclosure).not_to_have_attribute('open','')
            assert agent.evaluate("pane => {const diff=pane.querySelector('.pane-workbench-changes-diff'),arr=pane.querySelector('.pane-workbench-arrangements-disclosure');return !!diff&&!!arr&&!!(diff.compareDocumentPosition(arr)&Node.DOCUMENT_POSITION_FOLLOWING)}")
            expect(disclosure).to_be_visible()
            for size in ({'width':1000,'height':800},{'width':520,'height':700}):shot('changes-collapsed',size)
            db=root/'runtime/workspace.sqlite'
            sqlite_bytes={name:(root/'runtime'/name).stat().st_size for name in ('workspace.sqlite','workspace.sqlite-wal','workspace.sqlite-shm') if (root/'runtime'/name).exists()}
            print(json.dumps({'renderer':args.renderer,'pty':args.pty,'revision':workspace_read()['revision'],'phases':phases,'sqlite_bytes':sqlite_bytes,'screenshots':screenshots,'continuity':'pass','restart_undo':'pass'}))
            context.close(); browser.close()
    finally:
        if server.poll() is None:
            server.terminate(); server.wait(timeout=10)
        if shutil.which('tmux'):
            subprocess.run(['tmux', '-L', server_env['ORBIT_TMUX_SOCKET'], 'kill-server'], env=server_env, capture_output=True)
