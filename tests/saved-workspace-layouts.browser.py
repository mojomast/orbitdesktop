"""Disposable real-server preset apply, uncertain retry and iframe continuity.
Run with --renderer default or docking. Builds a disposable source copy only.
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
import urllib.request
import uuid
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--renderer', choices=('default', 'docking'), required=True)
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='orbit-saved-layout-browser-', dir='/tmp/opencode') as temporary:
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
    artifact = json.loads(subprocess.check_output(['python3', str(ROOT / 'scripts/plugin_publish.py'), str(root / 'fixture'), '--id', 'saved-layout-fixture', '--version', '1.0.0', '--title', 'Synthetic continuity', '--runtime', str(root / 'runtime')], env=env))
    token, workspace = secrets.token_urlsafe(32), str(uuid.uuid4())
    with (root / 'src/main.ts').open('a') as entry:
        entry.write('\nimport {showSavedWorkspaceLayouts as testSavedLayouts} from "./saved-workspace-layouts";\n')
        entry.write('const testSavedButton=document.createElement("button");testSavedButton.textContent="Test saved layouts";testSavedButton.style.cssText="position:fixed;top:90px;right:10px;z-index:99999";document.body.append(testSavedButton);')
        entry.write('testSavedButton.onclick=()=>testSavedLayouts(()=>'+json.dumps(token)+',()=>{const h=document.querySelector(document.documentElement.dataset.dockingRenderer==="docking"?".docking-root":".desktop-host")!;const r=h.getBoundingClientRect();return {width:r.width,height:r.height};});\n')
    subprocess.run(['node', str(ROOT / 'scripts/isolated_build.mjs'), '--source', str(root), '--dest', str(root / 'dist'), '--allow-source-dist'], cwd=root, env=env, check=True, stdout=subprocess.DEVNULL)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    ids, panes = [str(uuid.uuid4()) for _ in range(2)], [str(uuid.uuid4()) for _ in range(2)]
    state = {'version': 1, 'selected': ids[0], 'arc': 14, 'view': 'windows', 'monitors': [
        {'id': ids[i], 'name': f'Existing {i}', 'diagonal': 32, 'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19, 'frame': {'x': i*500, 'y': 20, 'width': 450, 'height': 400, 'z': i+1}, 'layout': {'type': 'pane', 'pane': {'id': panes[i], 'kind': 'browser', 'url': artifact['entry']}}} for i in range(2)]}
    server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'], cwd=root, env={**env, 'PORT': str(port), 'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd')}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def api(endpoint, action, **fields):
        req = urllib.request.Request(origin + endpoint, data=json.dumps({'workspace_id': workspace, 'action': action, **fields}).encode(), headers={'Origin': origin, 'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)
    try:
        for _ in range(200):
            if server.poll() is not None: raise RuntimeError('Disposable server exited')
            try: urllib.request.urlopen(origin+'/api/health', timeout=1).close(); break
            except OSError: time.sleep(.05)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1600, 'height': 1000})
            context.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id',"+json.dumps(workspace)+");localStorage.setItem('orbit.workspace.v1',JSON.stringify("+json.dumps(state)+"));}")
            page = context.new_page(); errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin+('/?renderer=docking' if args.renderer == 'docking' else '/'))
            if args.renderer == 'docking': page.wait_for_function("document.documentElement.dataset.dockingRenderer==='docking'")
            page.keyboard.press('Escape');page.get_by_role('button', name='Connect local host', exact=True).click()
            page.get_by_role('textbox', name='Host session token').fill(token);page.get_by_role('button', name='Unlock local host', exact=True).click()
            expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
            page.wait_for_function('ids=>ids.every(id=>document.querySelector(`.pane[data-pane-id="${id}"] iframe`))', arg=panes)
            for pane in panes:
                page.frame_locator(f'.pane[data-pane-id="{pane}"] iframe').locator('#draft').fill('retained-'+pane)
            page.evaluate('ids=>window.savedFrameRefs=ids.map(id=>{const f=document.querySelector(`.pane[data-pane-id="${id}"] iframe`);return {element:f,document:f.contentDocument};})', panes)
            page.get_by_role('button', name='Test saved layouts', exact=True).click()
            dialog = page.get_by_role('dialog', name='Saved workspace layouts', exact=True)
            expect(dialog.get_by_role('button', name='Save current workspace layout', exact=True)).to_be_enabled()
            dialog.get_by_role('textbox', name='Layout name', exact=True).fill('Named continuity')
            dialog.get_by_role('button', name='Save current workspace layout', exact=True).click()
            expect(dialog.get_by_label('Saved layout', exact=True)).to_contain_text('Named continuity')
            before = api('/api/workspace', 'read')
            changed = api('/api/workspace', 'layout_apply', base_revision=before['revision'], operation_id=str(uuid.uuid4()), intent='Change geometry', operations=[{'action': 'arrange_windows', 'window_ids': ids, 'width': 1200, 'height': 800, 'columns': 1, 'gap': 8}])
            dialog.get_by_role('button', name='Preview saved workspace layout', exact=True).click()
            apply = dialog.get_by_role('button', name='Apply saved workspace layout preview', exact=True);expect(apply).to_be_enabled()
            assert api('/api/workspace', 'read')['revision'] == changed['revision']
            lost = []
            def lose_response(route):
                body = route.request.post_data_json
                if body.get('action') == 'apply': lost.append(body);route.fetch();route.abort('failed')
                else: route.continue_()
            page.route('**/api/workspace-layouts', lose_response);apply.click()
            expect(dialog.locator('.saved-layout-status')).to_contain_text('Unresolved apply', timeout=20000)
            committed = api('/api/workspace', 'read');assert committed['revision'] == changed['revision']+1
            page.keyboard.press('Escape');expect(dialog).not_to_be_visible()
            page.unroute('**/api/workspace-layouts', lose_response)
            page.get_by_role('button', name='Test saved layouts', exact=True).click();dialog = page.get_by_role('dialog', name='Saved workspace layouts', exact=True)
            apply = dialog.get_by_role('button', name='Apply saved workspace layout preview', exact=True);expect(apply).to_have_text('Retry exact apply');apply.click()
            expect(dialog.locator('.saved-layout-status')).to_contain_text('exact receipt replay', timeout=20000)
            assert api('/api/workspace', 'read')['revision'] == committed['revision'];assert len(lost) == 1
            if args.renderer == 'docking':
                # Real renderer reconciles an atomic Compare commit without replacing frames.
                current = api('/api/workspace', 'read')
                grid = api('/api/workspace-layouts', 'arrange_preview', window_ids=ids, mode='compare', columns=2, viewport={'width': 1200, 'height': 800}, base_revision=current['revision'])
                result = api('/api/workspace-layouts', 'apply', layout=grid['layout'], viewport=grid['viewport'], replacements={}, base_revision=current['revision'], operation_id=str(uuid.uuid4()), intent='Browser atomic docking compare')
                assert result['revision'] == current['revision']+1
                assert result['placement_revision'] == result['revision']
                page.wait_for_timeout(2500)
            assert page.evaluate('ids=>ids.every((id,i)=>{const f=document.querySelector(`.pane[data-pane-id="${id}"] iframe`);return f===window.savedFrameRefs[i].element&&f.contentDocument===window.savedFrameRefs[i].document;})', panes)
            for pane in panes: expect(page.frame_locator(f'.pane[data-pane-id="{pane}"] iframe').locator('#draft')).to_have_value('retained-'+pane)
            # A second lost response proves reload recovery with the identical payload.
            dialog.get_by_role('button', name='Preview saved workspace layout', exact=True).click();expect(apply).to_be_enabled()
            page.route('**/api/workspace-layouts', lose_response);apply.click()
            expect(dialog.locator('.saved-layout-status')).to_contain_text('Unresolved apply', timeout=20000)
            reload_revision = api('/api/workspace', 'read')['revision']
            exact = lost[-1];page.unroute('**/api/workspace-layouts', lose_response);page.reload()
            if args.renderer == 'docking': page.wait_for_function("document.documentElement.dataset.dockingRenderer==='docking'")
            if page.get_by_role('button', name='Connect local host', exact=True).is_visible():
                page.get_by_role('button', name='Connect local host', exact=True).click();page.get_by_role('textbox', name='Host session token').fill(token);page.get_by_role('button', name='Unlock local host', exact=True).click()
            expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
            page.get_by_role('button', name='Test saved layouts', exact=True).click();dialog = page.get_by_role('dialog', name='Saved workspace layouts', exact=True)
            apply = dialog.get_by_role('button', name='Apply saved workspace layout preview', exact=True);expect(apply).to_have_text('Retry exact apply')
            with page.expect_request(lambda req: req.url.endswith('/api/workspace-layouts') and (req.post_data_json or {}).get('action') == 'apply') as retry:
                apply.click()
            assert retry.value.post_data_json == exact
            expect(dialog.locator('.saved-layout-status')).to_contain_text('exact receipt replay', timeout=20000)
            assert api('/api/workspace', 'read')['revision'] == reload_revision
            # X commits but its HTTP response is deferred. Close/reopen, explicitly
            # discard X after reading state, then retain Y before releasing late X.
            held = []
            def wait_held(count):
                deadline = time.monotonic()+10
                while len(held) < count and time.monotonic() < deadline: page.wait_for_timeout(20)
                assert len(held) == count
            def defer_apply(route):
                if route.request.post_data_json.get('action') == 'apply':
                    held.append((route, route.fetch(), route.request.post_data_json))
                else: route.continue_()
            page.route('**/api/workspace-layouts', defer_apply)
            dialog.get_by_role('button', name='Preview saved workspace layout', exact=True).click();expect(apply).to_be_enabled();apply.click()
            wait_held(1);page.keyboard.press('Escape');expect(dialog).not_to_be_visible()
            page.get_by_role('button', name='Test saved layouts', exact=True).click();dialog = page.get_by_role('dialog', name='Saved workspace layouts', exact=True)
            discard = dialog.get_by_role('button', name='Read authoritative state before discarding retained layout command', exact=True);expect(discard).to_be_enabled()
            page.once('dialog', lambda confirmation: confirmation.accept());discard.click()
            preview_button = dialog.get_by_role('button', name='Preview saved workspace layout', exact=True);expect(preview_button).to_be_enabled();preview_button.click()
            apply = dialog.get_by_role('button', name='Apply saved workspace layout preview', exact=True);expect(apply).to_be_enabled();apply.click()
            wait_held(2)
            retained_key = 'orbit.saved-layout.pending.'+workspace
            newer = held[1][2];assert newer['operation_id'] != held[0][2]['operation_id']
            assert page.evaluate('key=>JSON.parse(sessionStorage.getItem(key))', retained_key) == newer
            held[0][0].fulfill(response=held[0][1]);page.wait_for_timeout(150)
            assert page.evaluate('key=>JSON.parse(sessionStorage.getItem(key))', retained_key) == newer, 'Late X erased retained Y'
            held[1][0].fulfill(response=held[1][1]);expect(dialog.locator('.saved-layout-status')).to_contain_text('Saved revision', timeout=20000)
            assert page.evaluate('key=>sessionStorage.getItem(key)', retained_key) is None
            page.unroute('**/api/workspace-layouts', defer_apply)
            assert not errors, errors
            print(f'PASS {args.renderer}: durable preset, read-only preview, atomic apply, lost-response exact retry, iframe continuity, late X response preserves newer Y envelope')
            context.close();browser.close()
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill();server.wait()
