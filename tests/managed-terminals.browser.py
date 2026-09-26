"""Isolated real-server managed-terminal toolbar acceptance. Build dist first."""

import json
import argparse
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--renderer', choices=('default', 'docking'), default='default')
    args = parser.parse_args()
    assert (ROOT / 'dist/index.html').is_file(), 'Build the UI with npm run build first'
    assert shutil.which('tmux'), 'tmux is required for the isolated existing-session fixture'
    with tempfile.TemporaryDirectory(prefix='orbit-managed-browser-', dir='/tmp/opencode') as temporary:
        root = Path(temporary)
        for name in ('server', 'src', 'contracts', 'dist', 'scripts'):
            shutil.copytree(ROOT / name, root / name)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        shutil.copy2(ROOT / 'package.json', root / 'package.json')
        for name in ('runtime', 'home', 'cwd', 'tmux'):
            (root / name).mkdir(mode=0o700)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        token, workspace, pane, window = secrets.token_urlsafe(36), str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        state = {'version': 1, 'selected': window, 'arc': 14, 'view': 'windows', 'monitors': [
            {'id': window, 'name': 'Managed fixture', 'diagonal': 32, 'aspect': '16:9',
             'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19,
             'frame': {'x': 30, 'y': 30, 'width': 900, 'height': 650, 'z': 1},
             'layout': {'type': 'pane', 'pane': {'id': pane, 'kind': 'terminal', 'url': 'orbit://welcome'}}}]}
        socket_name = 'orbit-managed-' + secrets.token_hex(12)
        env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'PORT': str(port),
               'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': str(root / 'runtime'),
               'ORBIT_CWD': str(root / 'cwd'), 'TMUX_TMPDIR': str(root / 'tmux'),
               'ORBIT_TMUX_SOCKET': socket_name, 'ORBIT_TMUX_CONFIG': '/dev/null', 'TERM': 'xterm-256color'}
        tmux = [shutil.which('tmux'), '-L', socket_name, '-f', '/dev/null']
        subprocess.run([*tmux, 'new-session', '-d', '-s', 'pane-' + pane], env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
        subprocess.run([*tmux, 'send-keys', '-l', '-t', 'pane-' + pane + ':0.0', "export ORBIT_MANAGED_RELOAD=retained; printf 'FIXTURE_READ_MARKER\\n'"],
                       env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
        subprocess.run([*tmux, 'send-keys', '-t', 'pane-' + pane + ':0.0', 'Enter'],
                       env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
        server_log = root / 'server.log'
        with server_log.open('wb') as log:
            server = subprocess.Popen([shutil.which('node'), '--experimental-strip-types', 'server/index.mjs'],
                                      cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(160):
                    if server.poll() is not None:
                        raise RuntimeError('Disposable server exited during startup (see isolated server.log)')
                    try:
                        with urllib.request.urlopen(origin + '/api/health', timeout=1):
                            break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise RuntimeError('Disposable server health timed out')
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
                    try:
                        context = browser.new_context(viewport={'width': 1440, 'height': 900})
                        context.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id'," + json.dumps(workspace) + ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));}")
                        page = context.new_page()
                        page_errors, sockets, frames = [], [], []
                        page.on('pageerror', lambda error: page_errors.append(str(error)))
                        def track_socket(ws):
                            sockets.append(ws)
                            ws.on('framereceived', lambda payload: frames.append(payload))
                        page.on('websocket', track_socket)
                        managed_requests = []
                        page.on('request', lambda request: managed_requests.append(json.loads(request.post_data or '{}')) if request.url.endswith('/api/managed-terminals') else None)
                        page.goto(origin + ('/?renderer=docking' if args.renderer == 'docking' else '/'), wait_until='domcontentloaded')
                        page.keyboard.press('Escape')
                        page.get_by_role('button', name='Connect local host', exact=True).click()
                        page.get_by_role('textbox', name='Host session token').fill(token)
                        page.get_by_role('button', name='Unlock local host', exact=True).click()
                        expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
                        page.locator(f'.pane[data-pane-id="{pane}"]').get_by_role('button', name='Connect to local host shell').click()
                        toolbar = page.locator(f'.pane[data-pane-id="{pane}"] .terminal-bar')
                        expect(toolbar.get_by_role('button', name='Manage this terminal with explicit owner consent')).to_be_visible()
                        toolbar.get_by_role('button', name='Manage this terminal with explicit owner consent').click()
                        dialog = page.get_by_role('dialog', name='Managed terminal controls')
                        expect(dialog).to_be_visible()
                        assert managed_requests == [], 'Dialog open silently called managed route'
                        expect(dialog.get_by_role('textbox', name='Untrusted terminal output (read-only)')).to_have_value('')
                        dialog.locator('button', has_text='Reconcile').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('unmanaged')
                        assert [r['action'] for r in managed_requests] == ['reconcile'], 'Reconcile must not capture output'
                        page.once('dialog', lambda confirmation: confirmation.dismiss())
                        dialog.locator('button', has_text='Adopt…').click()
                        assert [r['action'] for r in managed_requests] == ['reconcile'], 'Dismissed adoption sent request'
                        page.once('dialog', lambda confirmation: confirmation.accept())
                        dialog.locator('button', has_text='Adopt…').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('managed', timeout=15000)
                        dialog.locator('button', has_text='Grant lease').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('Active observe lease')
                        assert 'observe' not in [r['action'] for r in managed_requests], 'Grant silently captured output'
                        dialog.locator('button', has_text='Read output once').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('One-shot output read', timeout=15000)
                        output = dialog.get_by_role('textbox', name='Untrusted terminal output (read-only)')
                        expect(output).to_have_value(re.compile('FIXTURE_READ_MARKER'))
                        assert len(output.input_value().encode()) <= 65536, 'Observed output exceeded bound'
                        assert [r['action'] for r in managed_requests].count('observe') == 1
                        dialog.locator('button', has_text='Revoke lease').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('Lease revoked')
                        expect(dialog.get_by_role('textbox', name='Untrusted terminal output (read-only)')).to_have_value('')
                        dialog.get_by_role('combobox', name='Lease scope').select_option('input')
                        dialog.locator('button', has_text='Grant lease').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('Active input lease')
                        dialog.get_by_role('textbox', name='Literal text to send').fill('FIXTURE_LITERAL_ONLY')
                        before_input = [r['action'] for r in managed_requests].count('input')
                        dialog.locator('button', has_text='Send literal text').click()
                        expect(dialog.locator('.managed-error')).to_contain_text('confirmation required')
                        assert [r['action'] for r in managed_requests].count('input') == before_input
                        dialog.get_by_role('checkbox', name='Confirm this input action').check()
                        dialog.locator('button', has_text='Send literal text').click()
                        expect(dialog.locator('.managed-operation')).to_contain_text('applied: yes', timeout=15000)
                        assert [r['action'] for r in managed_requests].count('input') == before_input + 1
                        # Dispatch for real, then replace only the response with an
                        # ambiguous timeout. Retry must use the immutable receipt.
                        subprocess.run([*tmux, 'send-keys', '-t', 'pane-' + pane + ':0.0', 'C-u'], env=env, check=True)
                        ambiguous_inputs = []
                        def ambiguous_response(route):
                            body = json.loads(route.request.post_data or '{}')
                            if body.get('action') == 'input':
                                ambiguous_inputs.append(body)
                                if len(ambiguous_inputs) == 1:
                                    actual = route.fetch()
                                    assert actual.ok and actual.json()['applied'] is True
                                    route.fulfill(status=504, content_type='application/json', body='{"ok":false,"error":"timeout","code":"timeout"}')
                                    return
                            route.continue_()
                        page.route('**/api/managed-terminals', ambiguous_response)
                        dialog.get_by_role('textbox', name='Literal text to send').fill("printf 'AMBIG_OUT_%s\\n' once\n")
                        dialog.get_by_role('checkbox', name='Confirm this input action').check()
                        dialog.get_by_role('checkbox', name='Acknowledge newline may execute commands').check()
                        dialog.locator('button', has_text='Send literal text').click()
                        expect(dialog.locator('.managed-error')).to_contain_text('timeout')
                        operation_id = ambiguous_inputs[0]['operation_id']
                        expect(dialog.locator('.managed-pending')).to_contain_text('Outcome unknown')
                        expect(dialog.locator('.managed-pending')).to_contain_text(operation_id)
                        # Closing, reopening, reconciling, and editing cannot change
                        # the retry payload or require a freshly read revision.
                        dialog.get_by_role('button', name='Close managed terminal controls').click()
                        toolbar.get_by_role('button', name='Manage this terminal with explicit owner consent').click()
                        expect(dialog.locator('.managed-pending')).to_contain_text(operation_id)
                        dialog.locator('button', has_text='Reconcile').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('managed')
                        expect(dialog.locator('.managed-pending')).to_contain_text(operation_id)
                        dialog.get_by_role('textbox', name='Literal text to send').fill('MUST_NOT_DISPATCH')
                        dialog.locator('button', has_text='Send literal text').click()
                        expect(dialog.locator('.managed-operation')).to_contain_text('applied: yes', timeout=15000)
                        expect(dialog.locator('.managed-pending')).to_be_hidden()
                        assert len(ambiguous_inputs) == 2, ambiguous_inputs
                        assert ambiguous_inputs[0] == ambiguous_inputs[1], 'Retry changed immutable input payload'
                        for _ in range(100):
                            capture = subprocess.check_output([*tmux, 'capture-pane', '-p', '-S', '-', '-t', 'pane-' + pane + ':0.0'], env=env, text=True)
                            if 'AMBIG_OUT_once' in capture: break
                            page.wait_for_timeout(50)
                        assert capture.count('AMBIG_OUT_once') == 1, capture
                        page.unroute('**/api/managed-terminals', ambiguous_response)
                        # Restore a visible lease for the existing revoke flow.
                        dialog.locator('button', has_text='Grant lease').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('Active observe lease')
                        dialog.locator('button', has_text='Revoke lease').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('Lease revoked')
                        # Reload an adopted terminal: reconnect must use attach-only,
                        # not new-session -A, retaining the shell variable and PID.
                        original_pid = subprocess.check_output([*tmux, 'display-message', '-p', '-t', 'pane-' + pane + ':0.0', '#{pane_pid}'], env=env, text=True).strip()
                        dialog.get_by_role('button', name='Close managed terminal controls').click()
                        page.reload(wait_until='domcontentloaded')
                        page.get_by_role('button', name='Connect local host', exact=True).click()
                        page.get_by_role('textbox', name='Host session token').fill(token)
                        page.get_by_role('button', name='Unlock local host', exact=True).click()
                        expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
                        page.locator(f'.pane[data-pane-id="{pane}"]').get_by_role('button', name='Connect to local host shell').click()
                        for _ in range(100):
                            if len(sockets) == 2 and sum('"type":"ready"' in str(frame) for frame in frames) >= 2: break
                            page.wait_for_timeout(50)
                        else: raise AssertionError('Reload did not reattach an interactive PTY: sockets=' + str(len(sockets)) + ' messages=' + str([json.loads(frame).get('type') for frame in frames if isinstance(frame, str) and frame.startswith('{')]))
                        subprocess.run([*tmux, 'send-keys', '-t', 'pane-' + pane + ':0.0', 'C-u'], env=env, check=True)
                        subprocess.run([*tmux, 'send-keys', '-l', '-t', 'pane-' + pane + ':0.0', "printf 'FRESH_RELOAD_%s_%s\\n' \"$ORBIT_MANAGED_RELOAD\" \"$$\""], env=env, check=True)
                        frames.clear()
                        subprocess.run([*tmux, 'send-keys', '-t', 'pane-' + pane + ':0.0', 'Enter'], env=env, check=True)
                        for _ in range(100):
                            if f'FRESH_RELOAD_retained_{original_pid}' in ''.join(map(str, frames)): break
                            page.wait_for_timeout(50)
                        else: raise AssertionError('Fresh output after reload did not retain shell variable/PID')
                        toolbar.get_by_role('button', name='Manage this terminal with explicit owner consent').click()
                        expect(dialog.get_by_role('textbox', name='Untrusted terminal output (read-only)')).to_have_value('')
                        page.once('dialog', lambda confirmation: confirmation.accept())
                        dialog.locator('button', has_text='Adopt…').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('managed', timeout=15000)
                        output = dialog.get_by_role('textbox', name='Untrusted terminal output (read-only)')
                        dialog.locator('button', has_text='Grant lease').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('Active observe lease')
                        # Hold the grant's revision read, revoke the existing lease,
                        # then resume. The stale grant must never reach the broker.
                        held_reads = []
                        def hold_revision(route):
                            body = json.loads(route.request.post_data or '{}')
                            if body.get('action') == 'read' and not held_reads:
                                held_reads.append(route)
                                return
                            route.continue_()
                        page.route('**/api/workspace', hold_revision)
                        before_race = len(managed_requests)
                        dialog.locator('button', has_text='Grant lease').click()
                        for _ in range(100):
                            if held_reads: break
                            page.wait_for_timeout(20)
                        assert held_reads, 'Grant revision read was not intercepted'
                        dialog.locator('button', has_text='Revoke lease').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('Lease revoked')
                        held_reads[0].continue_()
                        expect(dialog.locator('button', has_text='Grant lease')).to_be_enabled()
                        assert [r['action'] for r in managed_requests[before_race:]] == ['revoke'], managed_requests[before_race:]
                        expect(dialog.locator('.managed-status')).to_contain_text('Lease revoked')
                        expect(dialog.locator('.managed-status')).not_to_contain_text('Active')
                        page.unroute('**/api/workspace', hold_revision)
                        # The same cancellation must work with NO prior lease.
                        # Otherwise a first grant could appear after Revoke.
                        held_reads.clear()
                        page.route('**/api/workspace', hold_revision)
                        before_race = len(managed_requests)
                        dialog.locator('button', has_text='Grant lease').click()
                        for _ in range(100):
                            if held_reads: break
                            page.wait_for_timeout(20)
                        assert held_reads, 'First-grant revision read was not intercepted'
                        dialog.locator('button', has_text='Revoke lease').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('Pending action cancelled')
                        held_reads[0].continue_()
                        expect(dialog.locator('button', has_text='Grant lease')).to_be_enabled()
                        assert managed_requests[before_race:] == [], managed_requests[before_race:]
                        expect(dialog.locator('.managed-status')).not_to_contain_text('Active')
                        page.unroute('**/api/workspace', hold_revision)
                        dialog.locator('button', has_text='Grant lease').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('Active observe lease')
                        # Only this disposable Orbit process is restarted. Tmux
                        # stays alive; durable identity survives, grants do not.
                        server.terminate(); server.wait(timeout=5)
                        server = subprocess.Popen([shutil.which('node'), '--experimental-strip-types', 'server/index.mjs'], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
                        for _ in range(100):
                            try:
                                with urllib.request.urlopen(origin + '/api/health', timeout=1): break
                            except OSError: time.sleep(.05)
                        else: raise AssertionError('Disposable restarted server did not become ready')
                        current_pid = subprocess.check_output([*tmux, 'display-message', '-p', '-t', 'pane-' + pane + ':0.0', '#{pane_pid}'], env=env, text=True).strip()
                        assert current_pid == original_pid, 'Service restart replaced the shell'
                        dialog.locator('button', has_text='Read output once').click()
                        expect(dialog.locator('.managed-error')).to_contain_text('unauthorized', timeout=15000)
                        expect(output).to_have_value('')
                        page.once('dialog', lambda confirmation: confirmation.accept())
                        dialog.locator('button', has_text='Adopt…').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('managed', timeout=15000)
                        # Replace the adopted shell incarnation in the same tmux pane.
                        subprocess.run([*tmux, 'respawn-pane', '-k', '-t', 'pane-' + pane + ':0.0'], env=env,
                                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
                        dialog.locator('button', has_text='Reconcile').click()
                        expect(dialog.locator('.managed-status')).to_contain_text('identity_changed', timeout=15000)
                        dialog.locator('button', has_text='Grant lease').click()
                        expect(dialog.locator('.managed-error')).to_contain_text('identity changed', timeout=15000)
                        expect(output).to_have_value('')
                        assert not page_errors, page_errors
                        capability = json.loads((root / 'runtime' / 'workspace-access' / (workspace + '.json')).read_text())['capability']
                        request = urllib.request.Request(origin + '/api/workspace/control', data=json.dumps({'action':'read','workspace_id':workspace}).encode(), headers={'Origin':origin,'Authorization':'Bearer '+capability,'Content-Type':'application/json'})
                        for _ in range(60):
                            with urllib.request.urlopen(request) as response: snapshot = json.load(response)
                            if snapshot['observed_revision'] >= snapshot['revision']: break
                            page.wait_for_timeout(100)
                        assert snapshot['observed_revision'] >= snapshot['revision'], snapshot
                        page.screenshot(path=f'/tmp/opencode/orbit-managed-{args.renderer}.png')
                        print('PASS: isolated real-server managed toolbar, explicit adoption/read/input, ambiguous input exact retry with one tmux marker, revoke during held revision prevents grant, revoke, reload same shell variable/PID, service restart quarantines grants without replacing shell, identity change; renderer=', args.renderer, 'page_errors=',len(page_errors),'revision=',snapshot['revision'],'observed_revision=',snapshot['observed_revision'],'browser_applied=true')
                    finally:
                        browser.close()
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait(timeout=5)
                subprocess.run([*tmux, 'kill-server'], env=env, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=5, check=False)


if __name__ == '__main__':
    main()
