"""Real-server checkpoint comparison/restore, with disposable browser-only panes."""
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
    with tempfile.TemporaryDirectory(prefix='orbit-checkpoint-preview-', dir='/tmp/opencode') as temporary:
        root = Path(temporary)
        for name in ('server', 'src', 'contracts', 'public', 'docs', 'scripts'):
            shutil.copytree(ROOT / name, root / name)
        for name in ('package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.js'):
            shutil.copy2(ROOT / name, root / name)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        for name in ('runtime', 'home', 'cwd'):
            (root / name).mkdir()
        subprocess.run([shutil.which('node'), str(ROOT / 'scripts/isolated_build.mjs'), '--source', str(root), '--dest', str(root / 'dist'), '--allow-source-dist'], cwd=root, check=True, capture_output=True)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        workspace, window, pane = (str(uuid.uuid4()) for _ in range(3))
        token = 'checkpoint-fixture-' + uuid.uuid4().hex
        state = {'version': 1, 'selected': window, 'arc': 14, 'view': 'windows', 'monitors': [{
            'id': window, 'name': 'Original fixture', 'diagonal': 32, 'aspect': '16:9', 'height': 0,
            'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19,
            'layout': {'type': 'pane', 'pane': {'id': pane, 'kind': 'browser', 'url': 'orbit://welcome'}}}]}
        env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'PORT': str(port), 'ORBIT_TOKEN': token,
               'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd')}

        def api(action, **fields):
            request = urllib.request.Request(origin + '/api/workspace', data=json.dumps({'workspace_id': workspace, 'action': action, **fields}).encode(),
                                             headers={'Origin': origin, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)

        with (root / 'server.log').open('w+') as log:
            server = subprocess.Popen([shutil.which('node'), '--experimental-strip-types', 'server/index.mjs'], cwd=root, env=env, stdout=log, stderr=log)
            try:
                for _ in range(200):
                    if server.poll() is not None:
                        raise RuntimeError('Fixture server exited')
                    try:
                        urllib.request.urlopen(origin + '/api/health', timeout=1).close()
                        break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise RuntimeError('Fixture readiness timeout')
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
                    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                    context.add_init_script("if (window === window.top) { localStorage.setItem('orbit.onboarding.v1','done'); localStorage.setItem('orbit.onboarded','true'); localStorage.setItem('orbit.workspace.id', %s); localStorage.setItem('orbit.workspace.v1', %s); }" % (json.dumps(workspace), json.dumps(json.dumps(state))))
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.on('dialog', lambda dialog: dialog.accept())
                    page.goto(origin, wait_until='domcontentloaded')
                    page.get_by_role('button', name='Connect local host', exact=True).click()
                    page.get_by_role('textbox', name='Host session token').fill(token)
                    page.get_by_role('button', name='Unlock local host', exact=True).click()
                    expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
                    current = api('read')
                    api('checkpoint', base_revision=current['revision'], label='Review fixture checkpoint')
                    changed = json.loads(json.dumps(current['state']))
                    changed['monitors'][0]['name'] = 'Changed fixture'
                    changed['appearance'] = {'background': '#123456'}
                    committed = api('sync', base_revision=current['revision'], state=changed)
                    page.wait_for_function("() => JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors[0].name === 'Changed fixture'")
                    page.get_by_role('button', name='Open orbit menu', exact=True).click()
                    page.locator('.orbit-menu').get_by_role('button', name='Workspace checkpoints', exact=True).click()
                    dialog = page.get_by_role('dialog', name='Workspace checkpoints', exact=True)
                    select = dialog.get_by_role('button', name='Preview checkpoint Review fixture checkpoint', exact=True)
                    select.click()
                    detail = dialog.get_by_role('region', name='Checkpoint comparison')
                    expect(detail).to_contain_text('Appearance')
                    expect(detail).to_contain_text('Original fixture')
                    assert api('read')['revision'] == committed['revision'], 'Comparison mutated workspace'
                    # Make the preview stale, then prove the visible restore cannot overwrite it.
                    changed['arc'] = 5
                    newer = api('sync', base_revision=committed['revision'], state=changed)
                    dialog.get_by_role('button', name='Restore previewed checkpoint', exact=True).click()
                    expect(dialog.get_by_role('status')).to_contain_text('fresh comparison')
                    assert api('read')['revision'] == newer['revision']
                    select.click()
                    restore = dialog.get_by_role('button', name='Restore previewed checkpoint', exact=True)
                    expect(restore).to_be_enabled()
                    restore.click()
                    expect(dialog.get_by_role('status')).to_contain_text('Layout restored')
                    restored = api('read')
                    assert restored['state']['monitors'][0]['name'] == 'Original fixture'
                    assert restored['state']['monitors'][0]['layout']['pane']['id'] == pane
                    assert not errors, errors
                    browser.close()
                print('PASS: read-only checkpoint comparison, stale restore rejection, fresh restore and pane identity preservation')
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == '__main__':
    main()
