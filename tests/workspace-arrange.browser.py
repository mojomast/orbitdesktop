"""Disposable real-server standalone arrangement acceptance (Workbench disabled).

PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/workspace-arrange.browser.py --renderer default
Repeat with --renderer docking. Builds only a temporary source copy.
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
from playwright.sync_api import expect, sync_playwright
from browser_workspace import wait_for_workspace_connection

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--renderer', choices=('default', 'docking'), required=True)
args = parser.parse_args()

with tempfile.TemporaryDirectory(prefix='orbit-standalone-arrange-', dir='/tmp/opencode') as temporary:
    root = Path(temporary)
    for directory in ('src', 'server', 'contracts', 'docs', 'scripts', 'public'):
        shutil.copytree(ROOT / directory, root / directory)
    for name in ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js'):
        shutil.copy2(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    for directory in ('runtime', 'home', 'cwd', 'fixture'):
        (root / directory).mkdir()
    shutil.copy2(ROOT / 'tests/fixtures/runtime-continuity.html', root / 'fixture/index.html')
    env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home')}
    published = json.loads(subprocess.check_output(['python3', str(ROOT / 'scripts/plugin_publish.py'), str(root / 'fixture'),
        '--id', 'standalone-arrange', '--version', '1.0.0', '--title', 'Synthetic continuity', '--runtime', str(root / 'runtime')], cwd=root, env=env))
    token, workspace = secrets.token_urlsafe(32), str(uuid.uuid4())
    # Test-only launcher in the copied source exercises the public export without
    # depending on another agent's menu integration or touching the shared main.
    with (root / 'src/main.ts').open('a') as entry:
        entry.write('\nimport { showWorkspaceArrange as testArrange } from "./workspace-arrange";\n')
        entry.write('const testLaunch=document.createElement("button");testLaunch.textContent="Test arrange";testLaunch.style.cssText="position:fixed;top:90px;right:10px;z-index:99999";document.body.append(testLaunch);')
        entry.write('testLaunch.onclick=()=>testArrange(()=>'+json.dumps(token)+',()=>{const host=document.querySelector(document.documentElement.dataset.dockingRenderer==="docking"?".docking-root":".desktop-host")!;const r=host.getBoundingClientRect();return {width:r.width,height:r.height};});\n')
    subprocess.run(['node', str(ROOT / 'scripts/isolated_build.mjs'), '--source', str(root), '--dest', str(root / 'dist'), '--allow-source-dist'], cwd=root, env=env, check=True)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    ids, panes = [str(uuid.uuid4()) for _ in range(3)], [str(uuid.uuid4()) for _ in range(3)]
    state = {'version': 1, 'selected': ids[0], 'arc': 14, 'view': 'windows', 'monitors': [
        {'id': ids[i], 'name': f'Existing {i}', 'diagonal': 32, 'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19,
         'frame': {'x': i * 100, 'y': 20, 'width': 500, 'height': 400, 'z': i + 1},
         'layout': {'type': 'pane', 'pane': {'id': panes[i], 'kind': 'browser', 'url': published['entry']}}} for i in range(3)]}
    server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'], cwd=root,
        env={**env, 'PORT': str(port), 'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd')},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def api(action, **fields):
        request = urllib.request.Request(origin + '/api/workspace', data=json.dumps({'workspace_id': workspace, 'action': action, **fields}).encode(),
            headers={'Origin': origin, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    try:
        for _ in range(200):
            if server.poll() is not None: raise RuntimeError('Disposable server exited')
            try: urllib.request.urlopen(origin + '/api/health', timeout=1).close(); break
            except OSError: time.sleep(.05)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1600, 'height': 1000})
            context.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.experimental.v1','{\"version\":1,\"workbench\":false}');localStorage.setItem('orbit.workspace.id',"+json.dumps(workspace)+");localStorage.setItem('orbit.workspace.v1',JSON.stringify("+json.dumps(state)+"));}")
            page = context.new_page(); errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + ('/?renderer=docking' if args.renderer == 'docking' else '/'))
            if args.renderer == 'docking': page.wait_for_function("document.documentElement.dataset.dockingRenderer === 'docking'")
            page.keyboard.press('Escape')
            page.get_by_role('button', name='Connect local host', exact=True).click()
            page.get_by_role('textbox', name='Host session token').fill(token)
            page.get_by_role('button', name='Unlock local host', exact=True).click()
            wait_for_workspace_connection(page)
            page.wait_for_function('ids=>ids.every(id=>document.querySelector(`.pane[data-pane-id="${id}"] iframe`))', arg=panes)
            for pane in panes:
                page.frame_locator(f'.pane[data-pane-id="{pane}"] iframe').locator('#draft').fill('retained-' + pane)
            before = api('read')
            page.get_by_role('button', name='Test arrange', exact=True).click()
            dialog = page.get_by_role('dialog', name='Arrange workspace', exact=True)
            preview = dialog.get_by_role('button', name='Preview workspace arrangement', exact=True)
            apply = dialog.get_by_role('button', name='Apply exact workspace arrangement preview', exact=True)
            expect(preview).to_be_enabled()
            if args.renderer == 'docking':
                assert not dialog.get_by_label('Arrangement', exact=True).locator('option[value=grid]').is_disabled()
                dialog.get_by_role('checkbox', name='Arrange Existing 0', exact=True).uncheck()
                dialog.get_by_role('checkbox', name='Arrange Existing 1', exact=True).check()
            preview.click(); expect(apply).to_be_enabled()
            assert api('read')['revision'] == before['revision'], 'Preview mutated state'
            current = api('read')
            changed = api('layout_apply', base_revision=current['revision'], operations=[{'action': 'select', 'window_id': ids[2]}], operation_id=str(uuid.uuid4()), intent='Synthetic concurrent owner selection')
            apply.click(); expect(apply).to_be_disabled()
            expect(dialog.locator('.workspace-arrange-status')).to_contain_text('Workspace changed')
            assert api('read')['revision'] == changed['revision'], 'Stale preview overwrote state'
            preview.click(); expect(apply).to_be_enabled()
            page.set_viewport_size({'width': 1400, 'height': 900})
            expect(apply).to_be_disabled(timeout=5000)
            expect(dialog.locator('.workspace-arrange-status')).to_contain_text('Desktop size changed')
            preview.click(); expect(apply).to_be_enabled()
            host = page.locator('.docking-root' if args.renderer == 'docking' else '.desktop-host')
            size = host.evaluate('(h)=>({width:Math.floor(h.getBoundingClientRect().width),height:Math.floor(h.getBoundingClientRect().height)})')
            # Commit really reaches the disposable server, then lose its response.
            # Retry must replay the exact keyed command rather than rearrange twice.
            lost = []
            def lose_apply_response(route):
                body = route.request.post_data_json
                if body.get('action') == 'layout_apply':
                    lost.append(body)
                    route.fetch()
                    route.abort('failed')
                else:
                    route.continue_()
            page.route('**/api/workspace', lose_apply_response)
            apply.click()
            expect(dialog.locator('.workspace-arrange-status')).to_contain_text('Apply outcome unknown', timeout=20000)
            assert len(lost) == 1
            committed_revision = api('read')['revision']
            page.unroute('**/api/workspace', lose_apply_response)
            for pane in panes:
                assert page.frame_locator(f'.pane[data-pane-id="{pane}"] iframe').locator('#draft').input_value() == 'retained-' + pane
            retained_key = 'orbit.workspace.arrange.pending.' + workspace
            assert page.evaluate('(key)=>JSON.parse(sessionStorage.getItem(key))', retained_key) == lost[0]
            dialog.get_by_role('button', name='Close workspace arrangement', exact=True).click()
            expect(dialog).not_to_be_visible()
            page.get_by_role('button', name='Test arrange', exact=True).click()
            expect(apply).to_be_enabled()
            expect(preview).to_be_disabled()
            expect(dialog.locator('.workspace-arrange-status')).to_contain_text('Unresolved operation')
            def reject_retry(route):
                if route.request.post_data_json.get('action') == 'layout_apply':
                    route.fulfill(status=503, content_type='application/json', body='{"error":"Synthetic offline service"}')
                else:
                    route.continue_()
            page.route('**/api/workspace', reject_retry)
            apply.click()
            expect(dialog.locator('.workspace-arrange-status')).to_contain_text('Synthetic offline service')
            assert page.evaluate('(key)=>JSON.parse(sessionStorage.getItem(key))', retained_key) == lost[0]
            page.unroute('**/api/workspace', reject_retry)
            page.keyboard.press('Escape')
            expect(dialog).not_to_be_visible()
            page.reload()
            if args.renderer == 'docking': page.wait_for_function("document.documentElement.dataset.dockingRenderer === 'docking'")
            if page.get_by_role('button', name='Connect local host', exact=True).is_visible():
                page.get_by_role('button', name='Connect local host', exact=True).click()
                page.get_by_role('textbox', name='Host session token').fill(token)
                page.get_by_role('button', name='Unlock local host', exact=True).click()
            wait_for_workspace_connection(page)
            page.get_by_role('button', name='Test arrange', exact=True).click()
            expect(apply).to_be_enabled()
            expect(preview).to_be_disabled()
            expect(dialog.locator('.workspace-arrange-status')).to_contain_text('Unresolved operation')
            with page.expect_request(lambda request: request.url.endswith('/api/workspace') and (request.post_data_json or {}).get('action') == 'layout_apply') as retry:
                apply.click()
            assert retry.value.post_data_json == lost[0], 'Unknown-outcome retry changed operation identity or payload'
            expect(dialog.locator('.workspace-arrange-status')).to_contain_text('Browser acknowledged', timeout=20000)
            after = api('read')
            assert after['revision'] == committed_revision, 'Retry duplicated the mutation'
            assert page.evaluate('(key)=>sessionStorage.getItem(key)', retained_key) is None
            assert [m['id'] for m in after['state']['monitors']] == ids
            assert [m['layout'] for m in after['state']['monitors']] == [m['layout'] for m in state['monitors']]
            if args.renderer == 'default':
                for monitor in after['state']['monitors']:
                    frame = monitor['frame']
                    assert frame['x'] >= 0 and frame['y'] >= 0
                    assert frame['x'] + frame['width'] <= size['width'] and frame['y'] + frame['height'] <= size['height']
            else:
                assert after['state']['selected'] == ids[1]
                assert [m['frame'] for m in after['state']['monitors']] == [m['frame'] for m in state['monitors']]
            # Reload necessarily replaces iframe documents; continuity was tested
            # before reload, while stable model identity is checked after recovery.
            held = []
            def wait_held(count):
                deadline = time.monotonic()+10
                while len(held) < count and time.monotonic() < deadline: page.wait_for_timeout(20)
                assert len(held) == count
            def defer_apply(route):
                if route.request.post_data_json.get('action') == 'layout_apply':
                    held.append((route, route.fetch(), route.request.post_data_json))
                else: route.continue_()
            page.route('**/api/workspace', defer_apply)
            preview.click();expect(apply).to_be_enabled();apply.click()
            wait_held(1);page.keyboard.press('Escape');expect(dialog).not_to_be_visible()
            page.get_by_role('button', name='Test arrange', exact=True).click()
            discard_pending = dialog.get_by_role('button', name='Read authoritative state before discarding retained arrangement', exact=True);expect(discard_pending).to_be_enabled()
            page.once('dialog', lambda confirmation: confirmation.accept());discard_pending.click();expect(preview).to_be_enabled()
            preview.click();expect(apply).to_be_enabled();apply.click();wait_held(2)
            newer = held[1][2];assert newer['operation_id'] != held[0][2]['operation_id']
            assert page.evaluate('key=>JSON.parse(sessionStorage.getItem(key))', retained_key) == newer
            held[0][0].fulfill(response=held[0][1]);page.wait_for_timeout(150)
            assert page.evaluate('key=>JSON.parse(sessionStorage.getItem(key))', retained_key) == newer, 'Late standalone X erased retained Y'
            held[1][0].fulfill(response=held[1][1]);expect(dialog.locator('.workspace-arrange-status')).to_contain_text('Browser acknowledged', timeout=20000)
            assert page.evaluate('key=>sessionStorage.getItem(key)', retained_key) is None
            page.unroute('**/api/workspace', defer_apply)
            assert not errors, errors
            print(json.dumps({'renderer': args.renderer, 'workbench': False, 'stable_panes': True, 'stale_preview_rejected': True, 'resize_invalidated': True, 'acknowledged_revision': after['revision']}))
            browser.close()
    finally:
        server.terminate(); server.wait(timeout=10)
