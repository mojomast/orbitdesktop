"""Disposable Chromium placement persistence and reload/PTY continuity gate.

Build first with npm run build. Run with the same Playwright environment used by
tests/docking-workspace.browser.py. No owner runtime, profile or tmux socket is used.
"""
import importlib.util
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
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('docking_workspace_helpers', ROOT / 'tests/docking-workspace.browser.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def main():
    helpers.fresh_build()
    if not shutil.which('tmux'):
        raise RuntimeError('tmux is required for the reload shell-continuity assertion')
    with tempfile.TemporaryDirectory(prefix='orbit-docking-persist-', dir='/tmp/opencode') as temporary:
        root = Path(temporary)
        for name in ('server', 'src', 'contracts', 'dist', 'public', 'scripts'):
            shutil.copytree(ROOT / name, root / name)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        shutil.copy2(ROOT / 'package.json', root / 'package.json')
        for name in ('runtime', 'home', 'cwd', 'tmux', 'fixture'):
            (root / name).mkdir(mode=0o700)
        shutil.copy2(ROOT / 'tests/fixtures/runtime-continuity.html', root / 'fixture/index.html')
        publish = json.loads(subprocess.check_output([
            shutil.which('python3'), str(ROOT / 'scripts/plugin_publish.py'), str(root / 'fixture'),
            '--id', 'docking-persist-fixture', '--version', '1.0.0', '--title', 'Docking persistence fixture',
            '--runtime', str(root / 'runtime')], cwd=root,
            env={'PATH': os.environ['PATH'], 'HOME': str(root / 'home')}, text=True, timeout=60))
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        token, workspace = secrets.token_urlsafe(36), str(uuid.uuid4())
        windows = [str(uuid.uuid4()) for _ in range(3)]
        panes = [str(uuid.uuid4()) for _ in windows]
        monitors = [{
            'id': wid, 'name': f'Persistence {i}', 'diagonal': 32, 'aspect': '16:9',
            'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19,
            'frame': {'x': 30 + 220 * i, 'y': 30 + 45 * i, 'width': 620, 'height': 510, 'z': i + 1},
            'layout': {'type': 'pane', 'pane': {'id': panes[i],
                'kind': 'terminal' if i == 2 else 'browser',
                'url': 'orbit://welcome' if i == 2 else publish['entry']}}
        } for i, wid in enumerate(windows)]
        state = {'version': 1, 'selected': windows[0], 'arc': 14, 'view': 'windows', 'monitors': monitors}
        tmux_name = 'orbit-persist-' + secrets.token_hex(7)
        env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'PORT': str(port), 'ORBIT_TOKEN': token,
            'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd'),
            'TMUX_TMPDIR': str(root / 'tmux'), 'ORBIT_TMUX_SOCKET': tmux_name,
            'ORBIT_TMUX_CONFIG': '/dev/null', 'TERM': 'xterm-256color'}

        def read():
            capability = json.loads((root / 'runtime/workspace-access' / (workspace + '.json')).read_text())['capability']
            request = urllib.request.Request(origin + '/api/workspace/control',
                data=json.dumps({'workspace_id': workspace, 'action': 'read'}).encode(),
                headers={'Origin': origin, 'Authorization': 'Bearer ' + capability, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)

        def command(action, **fields):
            capability = json.loads((root / 'runtime/workspace-access' / (workspace + '.json')).read_text())['capability']
            request = urllib.request.Request(origin + '/api/workspace/control',
                data=json.dumps({'workspace_id':workspace,'action':action,'operation_id':str(uuid.uuid4()),'intent':'Isolated docking recovery acceptance',**fields}).encode(),
                headers={'Origin':origin,'Authorization':'Bearer '+capability,'Content-Type':'application/json'})
            with urllib.request.urlopen(request,timeout=15) as response: return json.load(response)

        log = root / 'server.err'
        with log.open('wb') as output:
            server = subprocess.Popen([shutil.which('node'), '--experimental-strip-types', 'server/index.mjs'],
                cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT)
            try:
                for _ in range(160):
                    if server.poll() is not None:
                        raise RuntimeError('Disposable server exited before readiness')
                    try:
                        with urllib.request.urlopen(origin + '/api/health', timeout=1):
                            break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise RuntimeError('Disposable server startup timed out')
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    context = browser.new_context(viewport={'width': 1600, 'height': 1000})
                    try:
                        helpers.seed(context, workspace, state)
                        page = context.new_page()
                        errors, actions, ws_data = [], [], []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.on('request', lambda request: actions.append(request.post_data_json.get('action'))
                            if request.method == 'POST' and request.url.endswith('/api/workspace')
                            and isinstance(request.post_data_json, dict) else None)
                        page.on('websocket', lambda socket: socket.on('framereceived',
                            lambda payload: ws_data.append(json.loads(payload))) if socket.url.endswith('/api/terminal') else None)
                        page.goto(origin + '/?renderer=docking')
                        page.wait_for_function("() => document.documentElement.dataset.dockingRenderer === 'docking'")

                        def unlock():
                            page.get_by_role('button', name='Connect local host', exact=True).click()
                            page.get_by_role('textbox', name='Host session token', exact=True).fill(token)
                            page.get_by_role('button', name='Unlock local host', exact=True).click()
                            expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)

                        unlock()
                        toolbar = page.get_by_role('toolbar', name='Docking layout', exact=True)
                        terminal = page.locator(f'.pane[data-pane-id="{panes[2]}"]')
                        toolbar.get_by_role('combobox', name='Docking window').select_option(windows[2])
                        toolbar.get_by_role('button', name='Select window').click()
                        terminal.get_by_role('button', name='Connect to local host shell').click()
                        expect(terminal.locator('.connection-state')).to_contain_text('LIVE SHELL', timeout=15000)
                        marker = 'P' + secrets.token_hex(5).upper()
                        terminal.locator('.xterm-helper-textarea').focus()
                        page.keyboard.type(f'export ORBIT_PERSIST_VAR=KEPT; printf "{marker}_%s_%s\\n" "$ORBIT_PERSIST_VAR" "$$"')
                        page.keyboard.press('Enter')

                        def shell_output(start):
                            deadline = time.monotonic() + 15
                            while time.monotonic() < deadline:
                                output = ''.join(item.get('data', '') for item in ws_data[start:] if item.get('type') == 'data')
                                match = re.search(marker + r'_KEPT_(\d+)', output)
                                if match:
                                    return match.group(1)
                                page.wait_for_timeout(100)
                            raise AssertionError('No terminal response with exported variable and shell PID')

                        shell_pid = shell_output(0)
                        toolbar.get_by_role('combobox', name='Docking window').select_option(windows[0])
                        toolbar.get_by_role('button', name='Select window').click()
                        frame = page.frame_locator(f'.pane[data-pane-id="{panes[0]}"] iframe')
                        nonce = frame.locator('#document-nonce').inner_text()
                        frame.locator('#draft').fill('ephemeral iframe draft')
                        toolbar.get_by_role('combobox', name='Docking window').select_option(windows[0])
                        toolbar.get_by_role('combobox', name='Docking target').select_option(windows[2])
                        toolbar.get_by_role('button', name='Dock right', exact=True).click()
                        for _ in range(100):
                            columns = read()
                            if columns.get('placement_revision', 0) > 0 and columns['placement']['layout'].get('type') == 'branch': break
                            page.wait_for_timeout(100)
                        else: raise AssertionError('Initial three-column arrangement did not save')
                        column_rects = [page.locator(f'.docking-placeholder[data-docking-window="{wid}"]').bounding_box() for wid in windows]
                        assert all(rect and rect['width'] > 0 for rect in column_rects), column_rects
                        page.reload(); unlock()
                        page.wait_for_function("() => document.documentElement.dataset.dockingRenderer === 'docking'")
                        for _ in range(100):
                            restored_rects = [page.locator(f'.docking-placeholder[data-docking-window="{wid}"]').bounding_box() for wid in windows]
                            if all(rect and all(abs(rect[key] - column_rects[i][key]) <= 6 for key in ('x','y','width','height')) for i, rect in enumerate(restored_rects)): break
                            page.wait_for_timeout(100)
                        else: raise AssertionError(f'Three collinear groups changed geometry on reload: {column_rects} -> {restored_rects}')
                        assert read()['placement_revision'] == columns['placement_revision'], 'Column hydration must not autosave'
                        assert frame.locator('#document-nonce').inner_text() != nonce
                        nonce = frame.locator('#document-nonce').inner_text()
                        frame.locator('#draft').fill('ephemeral iframe draft')
                        toolbar.get_by_role('combobox', name='Docking window').select_option(windows[0])
                        toolbar.get_by_role('combobox', name='Docking target').select_option(windows[1])
                        toolbar.get_by_role('button', name='Tab to target').click()
                        toolbar.get_by_role('combobox', name='Docking window').select_option(windows[2])
                        toolbar.get_by_role('button', name='Float window').click()
                        deadline = time.monotonic() + 15
                        while time.monotonic() < deadline:
                            snapshot = read()
                            placement = snapshot.get('placement') or {}
                            if snapshot.get('placement_revision', 0) > 0 and placement.get('floats') and \
                                    (placement.get('layout') or {}).get('windows') == windows[:2]:
                                break
                            page.wait_for_timeout(150)
                        else:
                            raise AssertionError(f'Grouping and float did not persist: {snapshot.get("placement")}')
                        assert 'placement_save' in actions, actions
                        assert placement['floats'][0]['windows'] == [windows[2]]
                        saved_frame = placement['floats'][0]['frame']
                        saved_revision = snapshot['placement_revision']
                        float_group = page.locator(f'.docking-placeholder[data-docking-window="{windows[2]}"]')
                        before_geometry = float_group.bounding_box()
                        assert before_geometry and before_geometry['width'] > 0
                        page.reload()
                        page.wait_for_function("() => document.documentElement.dataset.dockingRenderer === 'docking'")
                        unlock()
                        expect(page.locator(f'.docking-placeholder[data-docking-window="{windows[2]}"]')).to_have_count(1)
                        page.wait_for_function("id => window.__orbitDocking?.floating.includes(id)", arg=windows[2])
                        after = read()
                        assert after['placement_revision'] == saved_revision, 'Hydration must not autosave'
                        assert after['placement']['layout']['type'] == 'group' and after['placement']['layout']['windows'] == windows[:2], after['placement']['layout']
                        assert after['placement']['floats'][0]['frame'] == saved_frame
                        for _ in range(100):
                            after_geometry = page.locator(f'.docking-placeholder[data-docking-window="{windows[2]}"]').bounding_box()
                            if after_geometry and all(abs(after_geometry[key] - before_geometry[key]) <= 6 for key in ('x','y','width','height')): break
                            page.wait_for_timeout(100)
                        assert after_geometry and all(abs(after_geometry[key] - before_geometry[key]) <= 6
                            for key in ('x', 'y', 'width', 'height')), (before_geometry, after_geometry)
                        # A full navigation creates fresh iframe documents; their drafts are
                        # intentionally NOT preserved. The tmux shell survives reconnect.
                        new_frame = page.frame_locator(f'.pane[data-pane-id="{panes[0]}"] iframe')
                        assert new_frame.locator('#document-nonce').inner_text() != nonce
                        assert new_frame.locator('#draft').input_value() == ''
                        toolbar = page.get_by_role('toolbar', name='Docking layout', exact=True)
                        toolbar.get_by_role('combobox', name='Docking window').select_option(windows[2])
                        toolbar.get_by_role('button', name='Select window').click()
                        terminal = page.locator(f'.pane[data-pane-id="{panes[2]}"]')
                        terminal.get_by_role('button', name='Connect to local host shell').click()
                        expect(terminal.locator('.connection-state')).to_contain_text('LIVE SHELL', timeout=15000)
                        start = len(ws_data)
                        subprocess.run([shutil.which('tmux'), '-L', tmux_name, 'send-keys',
                            '-t', 'pane-' + panes[2], f'printf "{marker}_%s_%s\\n" "$ORBIT_PERSIST_VAR" "$$"', 'C-m'],
                            env=env, capture_output=True, check=True, timeout=5)
                        assert shell_output(start) == shell_pid
                        # Round-trip placement through the independent recovery UI,
                        # including an empty adjunct reset without live DOM disposal.
                        for _ in range(100):
                            latest = read()
                            if latest['state']['selected'] == windows[2] and latest['observed_revision'] >= latest['revision']: break
                            page.wait_for_timeout(100)
                        saved = command('checkpoint',base_revision=latest['revision'],label='Floating arrangement')
                        page.evaluate("ids => { window.__placementFrames = ids.map(id => { const pane = document.querySelector(`.pane[data-pane-id=\"${id}\"]`); return [pane, pane.querySelector('iframe')]; }); }", panes[:2])
                        command('placement_save',base_revision=read()['revision'],placement={'version':1,'layout':None,'floats':[],'active':None})
                        page.wait_for_function("() => window.__orbitDocking?.floating.length === 0")
                        assert page.evaluate("ids => ids.every((id,i) => { const pane = document.querySelector(`.pane[data-pane-id=\"${id}\"]`); return pane === window.__placementFrames[i][0] && pane.querySelector('iframe') === window.__placementFrames[i][1]; })", panes[:2])
                        recovery = context.new_page()
                        recovery.on('pageerror', lambda error: errors.append(str(error)))
                        recovery.goto(origin + '/recovery')
                        recovery.get_by_label('Owner token', exact=True).fill(token)
                        recovery.get_by_label('Workspace ID', exact=True).fill(workspace)
                        recovery.get_by_role('button', name='Connect', exact=True).click()
                        expect(recovery.get_by_role('status')).to_contain_text('Connected at revision')
                        recovery.locator(f'input[name="checkpoint"][value="{saved["checkpoint"]}"]').check()
                        recovery.get_by_label('I understand this restores saved workspace layout state').check()
                        recovery.get_by_role('button', name='Restore checkpoint', exact=True).click()
                        expect(recovery.get_by_role('status')).to_contain_text('accepted at revision')
                        page.wait_for_function("id => window.__orbitDocking?.floating.includes(id)",arg=windows[2])
                        assert page.evaluate("ids => ids.every((id,i) => { const pane = document.querySelector(`.pane[data-pane-id=\"${id}\"]`); return pane === window.__placementFrames[i][0] && pane.querySelector('iframe') === window.__placementFrames[i][1]; })", panes[:2])
                        recovery.screenshot(path='/tmp/opencode/orbit-placement-recovery.png')
                        recovery.close()
                        assert not errors, errors
                        for _ in range(60):
                            final = read()
                            if final['observed_revision'] >= final['revision']: break
                            page.wait_for_timeout(100)
                        assert final['observed_revision'] >= final['revision'], final
                        page.screenshot(path='/tmp/opencode/orbit-docking-persistence.png')
                        print(json.dumps({'result': 'PASS', 'placement_revision': saved_revision,
                            'grouped': windows[:2], 'floating': windows[2], 'shell_pid_retained': True,
                            'iframe_document_fresh': True, 'three_columns_restored': True, 'empty_reset_and_recovery_restore': True, 'page_errors': len(errors),
                            'revision': final['revision'], 'observed_revision': final['observed_revision'], 'browser_applied': True}))
                    finally:
                        context.close()
                        browser.close()
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
                subprocess.run([shutil.which('tmux'), '-L', tmux_name, 'kill-server'], env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)


if __name__ == '__main__':
    main()
