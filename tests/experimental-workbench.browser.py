"""Real-server gate test: Project Workbench is experimental, off by default,
and enabled only from Orbit settings.

No owner workspace, model, terminal or deployment is used. The pinned browser
runner builds an isolated copy of the current source. Verifies that every
Workbench surface is hidden while off (even when a pane's stored mode is
Workbench), that Orbit settings enables it without overwriting stored
preferences, and that disabling hides it again without deleting stored state.

PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
 /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/experimental-workbench.browser.py
"""
import json
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


def main():
    with tempfile.TemporaryDirectory(prefix='orbit-experimental-workbench-', dir='/tmp/opencode') as temporary:
        root = Path(temporary)
        for name in ('server', 'src', 'contracts', 'public', 'docs', 'scripts'):
            shutil.copytree(ROOT / name, root / name)
        for name in ('package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.js'):
            shutil.copy2(ROOT / name, root / name)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        for name in ('runtime', 'home', 'cwd'):
            (root / name).mkdir()
        subprocess.run([shutil.which('node'), str(ROOT / 'scripts/isolated_build.mjs'),
                        '--source', str(root), '--dest', str(root / 'dist'), '--allow-source-dist'],
                       cwd=root, check=True, capture_output=True, env={**os.environ, 'HOME': str(root / 'home')})
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        workspace, monitor, pane = (str(uuid.uuid4()) for _ in range(3))
        session = 'orbit-' + str(uuid.uuid4())
        state = {'version': 1, 'selected': monitor, 'arc': 14, 'view': 'windows', 'monitors': [{
            'id': monitor, 'name': 'Experimental gate fixture', 'diagonal': 32, 'aspect': '16:9',
            'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19,
            'frame': {'x': 0, 'y': 0, 'width': 1000, 'height': 900, 'z': 0},
            'layout': {'type': 'pane', 'pane': {'id': pane, 'kind': 'agent', 'url': ''}}}]}
        # The pane is deliberately left in Workbench mode from before the gate
        # existed: the feature must stay off and the preference must survive.
        prefs = {'version': 1, 'mode': 'workbench', 'projectId': None, 'taskId': None, 'candidateId': None,
                 'attemptId': None, 'grantId': None, 'resultId': None, 'reviewId': None, 'pairedPaneId': None}
        chat = {'session': session, 'profile_id': 'default', 'binding_revision': 1, 'messages': []}
        prefs_key = f'orbit-pane-prefs:{workspace}:{pane}'
        chat_key = f'orbit-hermes-chat:{pane}'
        token = 'fixture-owner-token-' + uuid.uuid4().hex + uuid.uuid4().hex
        env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'PORT': str(port),
               'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd')}
        with (root / 'server.log').open('w+') as log:
            server = subprocess.Popen([shutil.which('node'), '--experimental-strip-types', 'server/index.mjs'],
                                      cwd=root, env=env, stdout=log, stderr=log)
            try:
                for _ in range(200):
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    try:
                        urllib.request.urlopen(origin + '/api/health', timeout=1).close()
                        break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise RuntimeError('Server readiness timeout')
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
                    context = browser.new_context(viewport={'width': 1400, 'height': 1000})
                    context.add_init_script('''(function() {
                      localStorage.setItem('orbit.onboarding.v1','done');
                      localStorage.setItem('orbit.onboarded','true');
                      localStorage.setItem('orbit.workspace.id', %s);
                      localStorage.setItem('orbit.workspace.v1', %s);
                      localStorage.setItem(%s, %s);
                      sessionStorage.setItem(%s, %s);
                    })()''' % (json.dumps(workspace), json.dumps(json.dumps(state)),
                               json.dumps(prefs_key), json.dumps(json.dumps(prefs)),
                               json.dumps(chat_key), json.dumps(json.dumps(chat))))

                    def route_workbench(route):
                        try:
                            body = route.request.post_data_json or {}
                        except Exception:
                            body = {}
                        if body.get('action') == 'stream':
                            route.fulfill(status=503, json={'ok': False, 'code': 'fixture_page_transport'})
                            return
                        route.fulfill(json={
                            'ok': True, 'projects': [], 'tasks': [], 'candidates': [], 'grants': [], 'cards': [],
                            'attempts': [], 'contexts': [], 'packets': [], 'events': [], 'lane': {},
                            'after_sequence': 0, 'has_more': False, 'snapshot': {},
                        })

                    context.route('**/api/workbench**', route_workbench)
                    errors = []
                    page = context.new_page()
                    page.on('pageerror', lambda error: errors.append(str(error)))

                    def storage():
                        return page.evaluate("JSON.parse(localStorage.getItem('orbit.experimental.v1')||'null')")

                    def workbench_mounted():
                        return page.locator(f'.pane[data-pane-id="{pane}"] [aria-label="Pane Workbench"]').count()

                    def orbit_menu_item(name):
                        return page.locator('.orbit-menu').get_by_role('button', name=name, exact=True)

                    page.goto(origin, wait_until='domcontentloaded')
                    fixture = page.locator(f'.pane[data-pane-id="{pane}"]')
                    expect(fixture).to_be_visible()

                    # ---- Default: off, Workbench surfaces hidden. ----
                    assert storage() is None, storage()
                    expect(fixture.get_by_role('button', name='Normal Hermes mode', exact=True)).to_be_hidden()
                    expect(fixture.get_by_role('button', name='Workbench Hermes mode', exact=True)).to_be_hidden()
                    expect(fixture.get_by_role('button', name='Create Workbench task', exact=True)).to_be_hidden()
                    expect(fixture.locator('.agent-chat-normal')).to_be_visible()
                    expect(fixture.locator('.agent-workbench-host')).to_be_hidden()
                    assert workbench_mounted() == 0, 'Workbench mounted while disabled'
                    notice = fixture.locator('.agent-experimental-notice')
                    expect(notice).to_be_visible()
                    expect(notice).to_contain_text('Project Workbench is experimental and off')
                    fixture.get_by_role('button', name='Agent pane menu', exact=True).click()
                    expect(page.get_by_role('menuitem', name='Set up task', exact=True)).to_be_hidden()
                    page.keyboard.press('Escape')

                    # Orbit menu and Start hide every separate Workbench entry.
                    page.get_by_role('button', name='Open orbit menu', exact=True).click()
                    expect(orbit_menu_item('New Workbench window')).to_be_hidden()
                    expect(orbit_menu_item('Project Workbench')).to_be_hidden()
                    expect(orbit_menu_item('Orbit settings')).to_be_visible()
                    page.get_by_role('button', name='Close orbit menu', exact=True).click()
                    page.get_by_role('button', name='Open Start', exact=True).click()
                    expect(page.locator('.start-panel')).to_be_visible()
                    expect(page.locator('.start-panel').get_by_text('New Workbench window', exact=True)).to_have_count(0)
                    page.keyboard.press('Escape')

                    # ---- Enable from the gate notice. ----
                    notice.get_by_role('button', name='Enable in Orbit settings', exact=True).click()
                    dialog = page.get_by_role('dialog', name='Orbit settings')
                    expect(dialog).to_be_visible()
                    toggle = dialog.get_by_role('checkbox', name='Project Workbench (experimental)')
                    expect(toggle).not_to_be_checked()
                    toggle.check()
                    assert storage() == {'version': 1, 'workbench': True}, storage()
                    dialog.get_by_role('button', name='Done', exact=True).click()
                    expect(dialog).to_be_hidden()
                    expect(fixture.get_by_role('button', name='Workbench Hermes mode', exact=True)).to_be_visible()
                    expect(notice).to_be_hidden()
                    expect(fixture.locator('.agent-workbench-host')).to_be_visible()
                    # The stored Workbench mode is restored, never rewritten by the gate.
                    assert page.evaluate('JSON.parse(localStorage.getItem(%s)).mode' % json.dumps(prefs_key)) == 'workbench'
                    fixture.get_by_role('button', name='Normal Hermes mode', exact=True).click()
                    expect(fixture.locator('.agent-chat-normal')).to_be_visible()
                    expect(fixture.get_by_role('button', name='Create Workbench task', exact=True)).to_be_visible()

                    # Separate Workbench entries appear with the same switch.
                    page.get_by_role('button', name='Open orbit menu', exact=True).click()
                    expect(orbit_menu_item('New Workbench window')).to_be_visible()
                    expect(orbit_menu_item('Project Workbench')).to_be_visible()
                    expect(orbit_menu_item('Orbit settings')).to_be_visible()
                    page.get_by_role('button', name='Close orbit menu', exact=True).click()
                    page.get_by_role('button', name='Open Start', exact=True).click()
                    expect(page.locator('.start-panel').get_by_text('New Workbench window', exact=True)).to_have_count(1)
                    page.keyboard.press('Escape')

                    # ---- Preference survives a reload while enabled. ----
                    page.reload(wait_until='domcontentloaded')
                    expect(fixture.get_by_role('button', name='Workbench Hermes mode', exact=True)).to_be_visible()
                    expect(fixture.locator('.agent-experimental-notice')).to_be_hidden()

                    # ---- Disable again from Orbit settings; nothing is deleted. ----
                    page.get_by_role('button', name='Open orbit menu', exact=True).click()
                    orbit_menu_item('Orbit settings').click()
                    dialog = page.get_by_role('dialog', name='Orbit settings')
                    dialog.get_by_role('checkbox', name='Project Workbench (experimental)').uncheck()
                    assert storage() == {'version': 1, 'workbench': False}, storage()
                    dialog.get_by_role('button', name='Done', exact=True).click()
                    expect(fixture.get_by_role('button', name='Workbench Hermes mode', exact=True)).to_be_hidden()
                    expect(fixture.locator('.agent-workbench-host')).to_be_hidden()
                    expect(fixture.locator('.agent-chat-normal')).to_be_visible()
                    expect(fixture.locator('.agent-experimental-notice')).to_be_visible()
                    assert page.evaluate('JSON.parse(localStorage.getItem(%s)).mode' % json.dumps(prefs_key)) == 'workbench'
                    # A fresh load with the feature off never mounts Workbench at all.
                    page.reload(wait_until='domcontentloaded')
                    expect(fixture.locator('.agent-workbench-host')).to_be_hidden()
                    expect(fixture.locator('.agent-experimental-notice')).to_be_visible()
                    assert workbench_mounted() == 0, 'Workbench mounted on a disabled fresh load'

                    assert not errors, errors
                    browser.close()
                print('PASS: Workbench hidden by default, revealed only via Orbit settings, preference and stored state preserved across enable/reload/disable')
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == '__main__':
    main()
