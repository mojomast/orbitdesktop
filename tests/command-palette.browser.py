"""Disposable shell command test. No owner runtime, terminals or providers used."""
import json
import argparse
import re
import os
from pathlib import Path
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
parser.add_argument('--renderer', choices=('default', 'docking'), default='default')
args = parser.parse_args()

with tempfile.TemporaryDirectory(prefix='orbit-command-palette-', dir='/tmp/opencode') as temporary:
    root = Path(temporary)
    for name in ('server', 'src', 'contracts', 'public', 'docs', 'scripts'):
        shutil.copytree(ROOT / name, root / name)
    for name in ('package.json', 'index.html', 'tsconfig.json', 'vite.config.js'):
        shutil.copy2(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    for name in ('runtime', 'home', 'cwd'):
        (root / name).mkdir()
    env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home')}
    subprocess.run([shutil.which('node'), str(ROOT / 'scripts/isolated_build.mjs'), '--source', str(root),
                    '--dest', str(root / 'dist'), '--allow-source-dist'], cwd=root, env=env, check=True, capture_output=True)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    token = 'fixture-' + uuid.uuid4().hex + uuid.uuid4().hex
    workspace, monitor, pane = (str(uuid.uuid4()) for _ in range(3))
    state = {'version': 1, 'selected': monitor, 'arc': 14, 'view': 'windows', 'monitors': [{
        'id': monitor, 'name': 'Palette fixture', 'diagonal': 32, 'aspect': '16:9', 'height': 0,
        'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19,
        'frame': {'x': 20, 'y': 20, 'width': 700, 'height': 500, 'z': 0},
        'layout': {'type': 'pane', 'pane': {'id': pane, 'kind': 'browser', 'url': 'https://palette-fixture.invalid/'}}}]}
    server = subprocess.Popen([shutil.which('node'), '--experimental-strip-types', 'server/index.mjs'], cwd=root,
        env={**env, 'PORT': str(port), 'ORBIT_TOKEN': token,
             'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd')},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(200):
            if server.poll() is not None:
                raise RuntimeError('Disposable server exited')
            try:
                urllib.request.urlopen(origin + '/api/health', timeout=1).close()
                break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError('Disposable server readiness timeout')
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1400, 'height': 1000})
            context.route('https://palette-fixture.invalid/**', lambda route: route.fulfill(content_type='text/html', body='<p>Disposable iframe fixture</p>'))
            context.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id',%s);localStorage.setItem('orbit.workspace.v1',%s);}" %
                                    (json.dumps(workspace), json.dumps(json.dumps(state))))
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            workspace_reads = []

            def record_workspace_read(response):
                if response.url != origin + '/api/workspace' or not response.ok:
                    return
                request = response.request.post_data_json
                if request and request.get('action') == 'read':
                    workspace_reads.append((request, response.json()))

            page.on('response', record_workspace_read)
            page.goto(origin + ('/?renderer=docking' if args.renderer == 'docking' else '/'))
            if args.renderer == 'docking':
                page.wait_for_function("() => document.documentElement.dataset.dockingRenderer === 'docking'")
            expect(page.locator(f'.pane[data-pane-id="{pane}"]')).to_be_visible()
            page.evaluate("() => window.fixturePane = document.querySelector('.pane')")
            trigger = page.get_by_role('button', name='Open Start', exact=True)
            trigger.focus()
            page.keyboard.press('Control+k')
            palette = page.get_by_role('dialog', name='Workspace commands', exact=True)
            search = palette.get_by_role('combobox', name='Search workspace commands')
            expect(search).to_be_focused()
            search.fill('Workbench')
            expect(palette.get_by_role('option')).to_have_count(0)
            search.fill('checkpoints')
            option = palette.get_by_role('option')
            expect(option).to_have_attribute('aria-disabled', 'true')
            expect(option).to_contain_text('Connect host first')
            page.keyboard.press('Enter')
            expect(palette).to_be_visible()
            search.fill('no-such-command')
            expect(palette.get_by_role('status')).to_contain_text('No matching')
            page.keyboard.press('Escape')
            expect(palette).to_have_count(0)
            expect(trigger).to_be_focused()
            # Shortcuts do not steal text editing, iframe or another modal's input.
            page.get_by_role('textbox', name='Browser address', exact=True).focus()
            page.keyboard.press('Control+k')
            expect(palette).to_have_count(0)
            page.locator('iframe').first.evaluate('(frame) => frame.focus()')
            page.keyboard.press('Control+k')
            expect(palette).to_have_count(0)
            trigger.focus()
            page.keyboard.press('Meta+k')
            expect(search).to_be_focused()
            search.fill('Orbit settings')
            page.keyboard.press('Enter')
            settings = page.get_by_role('dialog', name='Orbit settings', exact=True)
            expect(settings).to_be_visible()
            settings.get_by_role('checkbox', name='Project Workbench (experimental)').check()
            page.keyboard.press('Control+k')
            expect(palette).to_have_count(0)
            settings.get_by_role('button', name='Selected window settings', exact=True).click()
            options = page.get_by_role('dialog', name='Window options', exact=True)
            expect(options).to_be_visible()
            options.get_by_role('button', name='Close window options').click()
            trigger.focus()
            page.keyboard.press('Control+k')
            search.fill('Workbench')
            expect(palette.get_by_role('option')).to_have_count(2)
            page.keyboard.press('Escape')
            # Shared Start registry exposes the same commands and gate.
            trigger.click()
            page.get_by_role('searchbox', name='Search Start').fill('Workbench')
            expect(page.locator('.start-results button')).to_have_count(2)
            page.keyboard.press('Escape')
            trigger.focus()
            page.keyboard.press('Control+k')
            search.fill('new browser')
            page.keyboard.press('ArrowDown')
            page.keyboard.press('Enter')
            expect(page.locator('.monitor')).to_have_count(2)
            assert page.evaluate("() => window.fixturePane === document.querySelector('[data-pane-id=\"%s\"]')" % pane)
            # Host event reuses stable panes and stores no token in its opaque URL.
            for _ in range(2):
                page.evaluate("() => window.dispatchEvent(new CustomEvent('orbit-open-host-surface',{detail:{id:'outputs'}}))")
            expect(page.locator('.monitor')).to_have_count(3)
            page.wait_for_function("() => JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors.some(m=>m.layout.pane?.url==='orbit://surface/outputs')")
            # Real owner connection: merely opening, previewing and cancelling
            # arrangements from Spatial/Focus must never commit view changes.
            page.get_by_role('button', name='Connect local host', exact=True).click()
            page.get_by_role('textbox', name='Host session token').fill(token)
            page.get_by_role('button', name='Unlock local host', exact=True).click()
            expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)

            def read_workspace():
                response = page.request.post(origin + '/api/workspace',
                    headers={'Origin': origin, 'Authorization': 'Bearer ' + token},
                    data={'workspace_id': workspace, 'action': 'read'})
                assert response.ok, response.text()
                return response.json()

            def palette_command(query):
                page.get_by_role('button', name='Open orbit menu', exact=True).focus()
                page.keyboard.press('Control+k')
                search.fill(query)
                page.keyboard.press('Enter')

            def settled_workspace(pump=lambda: None):
                # Saved locally is only the 200 ms localStorage debounce. A fresh
                # browser read at the authoritative revision proves sync's queued
                # layout/placement saves have completed: sync chooses read only
                # after its placement tail and pending request, with changes sent.
                # Require browser state equality too, rather than treating network
                # activity or a stale status message as acknowledgement.
                first_read = len(workspace_reads)
                deadline = time.monotonic() + 15
                last = None
                while time.monotonic() < deadline:
                    pump()
                    last = read_workspace()
                    local = page.evaluate("() => ({saving:document.querySelector('.saved').textContent==='Saving…',state:JSON.parse(localStorage.getItem('orbit.workspace.v1'))})")
                    acknowledged = any(
                        request.get('observed_revision') == result.get('revision') == last['revision']
                        and result.get('state') == last['state']
                        for request, result in workspace_reads[first_read:])
                    if acknowledged and not local['saving'] and local['state'] == last['state']:
                        return last
                    page.wait_for_timeout(50)
                raise AssertionError(('Workspace did not settle', last, local, workspace_reads[first_read:]))

            # Reference geometry is the real laid-out root before it is hidden.
            size = page.locator('.docking-root' if args.renderer == 'docking' else '.desktop-host').evaluate(
                '(host) => ({width:host.clientWidth,height:host.clientHeight})')
            assert size['width'] >= 280 and size['height'] >= 180, size
            settled_workspace()
            # Hold the first Spatial save beyond the old 1 s sleep. The browser
            # has switched while the server still has Windows; the barrier must
            # wait for release, commit and a subsequent browser acknowledgement.
            delayed_sync = {}

            def hold_spatial_sync(route):
                request = route.request.post_data_json
                if (request.get('action') == 'sync' and request.get('state', {}).get('view') == 'spatial'
                        and not delayed_sync):
                    delayed_sync.update(route=route, started=time.monotonic())
                else:
                    route.continue_()

            def release_spatial_sync():
                if not delayed_sync or 'released' in delayed_sync:
                    return
                assert read_workspace()['state']['view'] == 'windows'
                if time.monotonic() - delayed_sync['started'] >= 1.5:
                    delayed_sync['route'].continue_()
                    delayed_sync['released'] = time.monotonic()

            page.route(origin + '/api/workspace', hold_spatial_sync)
            palette_command('Spatial view')
            expect(page.locator('.workspace')).not_to_have_class(re.compile(r'.*windows-mode.*'))
            assert settled_workspace(release_spatial_sync)['state']['view'] == 'spatial'
            assert delayed_sync['released'] - delayed_sync['started'] >= 1.5
            page.unroute(origin + '/api/workspace', hold_spatial_sync)
            for focused_mode in (False, True):
                if focused_mode:
                    palette_command('Focus selected window')
                    expect(page.locator('.workspace')).to_have_class(re.compile(r'.*is-focused.*'))
                for entrypoint in ('menu', 'palette', 'settings'):
                    before = settled_workspace()
                    assert before['state']['view'] == 'spatial'
                    page.evaluate("() => {const pane=window.fixturePane;window.arrangeIdentity={pane,frame:pane.querySelector('iframe'),document:pane.querySelector('iframe').contentWindow};}")
                    if entrypoint == 'palette':
                        palette_command('Arrange workspace')
                    else:
                        page.get_by_role('button', name='Open orbit menu', exact=True).click()
                        menu = page.locator('.orbit-menu')
                        if entrypoint == 'settings':
                            menu.get_by_role('button', name='Orbit settings', exact=True).click()
                            page.get_by_role('dialog', name='Orbit settings', exact=True).get_by_role('button', name='Arrange workspace', exact=True).click()
                        else:
                            menu.get_by_role('button', name='Arrange workspace', exact=True).click()
                    arrangement = page.get_by_role('dialog', name='Arrange workspace', exact=True)
                    preview = arrangement.get_by_role('button', name='Preview workspace arrangement', exact=True)
                    expect(preview).to_be_enabled(timeout=15000)
                    preview.click()
                    expect(arrangement.locator('.workspace-arrange-status')).to_contain_text('Preview validated', timeout=15000)
                    expect(arrangement.locator('.workspace-arrange-summary')).to_contain_text(f"desktop {size['width']} × {size['height']}")
                    arrangement.get_by_role('button', name='Discard workspace arrangement preview', exact=True).click()
                    arrangement.get_by_role('button', name='Close workspace arrangement', exact=True).click()
                    after = settled_workspace()
                    assert after['revision'] == before['revision'], (entrypoint, focused_mode, before['revision'], after['revision'])
                    assert after['state'] == before['state'], (entrypoint, focused_mode)
                    assert page.locator('.workspace').evaluate("node => node.classList.contains('is-focused')") == focused_mode
                    assert page.evaluate("() => {const old=window.arrangeIdentity;return old.pane.isConnected && old.pane===window.fixturePane && old.frame===old.pane.querySelector('iframe') && old.document===old.frame.contentWindow;}")
                    if page.locator('.orbit-menu').is_visible():
                        page.get_by_role('button', name='Close orbit menu', exact=True).click()
            # The shell opens the durable preset dialog with real measured
            # geometry, including while Spatial/Focus hides the desktop host.
            before_saved = settled_workspace()
            palette_command('Saved workspace layouts')
            saved = page.get_by_role('dialog', name='Saved workspace layouts', exact=True)
            expect(saved.locator('.saved-layout-status')).to_contain_text('saved layouts')
            saved.get_by_role('textbox', name='Layout name', exact=True).fill('Shell fixture layout')
            saved.get_by_role('button', name='Save current workspace layout', exact=True).click()
            expect(saved.locator('.saved-layout-status')).to_contain_text('1 saved layouts')
            saved.get_by_role('button', name='Close saved workspace layouts', exact=True).click()
            after_saved = settled_workspace()
            assert after_saved['revision'] == before_saved['revision']
            assert after_saved['state'] == before_saved['state']
            palette_command('Saved workspace layouts')
            saved = page.get_by_role('dialog', name='Saved workspace layouts', exact=True)
            expect(saved.get_by_role('combobox', name='Saved layout', exact=True)).to_contain_text('Shell fixture layout')
            saved.get_by_role('button', name='Close saved workspace layouts', exact=True).click()

            # Selection capture survives opening the palette, but does not read
            # embedded frames or auto-send/create a recipient.
            page.evaluate('''()=>{
              const text=document.createElement('p');text.id='transfer-selection-fixture';
              text.textContent='Explicit workspace selection <img onerror=alert(1)>';
              document.body.append(text);
              const range=document.createRange();range.selectNodeContents(text);
              const selected=document.getSelection();selected.removeAllRanges();selected.addRange(range);
              document.dispatchEvent(new Event('selectionchange'));
            }''')
            before_transfer = settled_workspace()
            palette_command('Send selected text to conversation')
            transfer = page.get_by_role('dialog', name='Send text to a conversation', exact=True)
            expect(transfer.locator('.conversation-transfer-preview')).to_have_text('Explicit workspace selection <img onerror=alert(1)>')
            expect(transfer.get_by_role('button', name='Insert into draft', exact=True)).to_be_disabled()
            assert transfer.locator('img').count() == 0
            transfer.get_by_role('button', name='Cancel', exact=True).click()
            after_transfer = settled_workspace()
            assert after_transfer['revision'] == before_transfer['revision']
            assert after_transfer['state'] == before_transfer['state']
            assert not errors, errors
            browser.close()
        print(f'PASS ({args.renderer}): palette keyboard/accessibility, safe focus, disabled reasons, experimental gate, shared Start, settings navigation, host-surface reuse; owner-connected menu/palette/settings arrange preview/cancel preserves Spatial/Focus revision, state and pane identity')
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
