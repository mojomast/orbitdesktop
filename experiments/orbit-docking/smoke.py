"""Small disposable smoke test; the parallel acceptance harness owns the full PTY gate."""
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='orbit-docking-smoke-', dir='/tmp/opencode') as tmp:
    root = Path(tmp)
    for name in ('server', 'src', 'contracts'):
        shutil.copytree(ROOT / name, root / name)
    shutil.copytree('/tmp/opencode/orbit-docking-build', root / 'dist/orbit-docking')
    shutil.copy(ROOT / 'package.json', root / 'package.json')
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    for name in ('runtime', 'home', 'cwd', 'tmux', 'fixture'):
        (root / name).mkdir(mode=0o700)
    shutil.copy(ROOT / 'tests/fixtures/runtime-continuity.html', root / 'fixture/index.html')
    clean = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home')}
    manifest = json.loads(subprocess.check_output(['python3', str(ROOT / 'scripts/plugin_publish.py'), str(root / 'fixture'), '--id', 'docking-smoke', '--version', '1.0.0', '--title', 'Docking smoke', '--runtime', str(root / 'runtime')], text=True, env=clean))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**clean, 'PORT': str(port), 'ORBIT_TOKEN': secrets.token_urlsafe(36), 'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd'), 'TMUX_TMPDIR': str(root / 'tmux'), 'ORBIT_TMUX_SOCKET': 'orbit-docking-smoke-' + secrets.token_hex(8), 'ORBIT_TMUX_CONFIG': '/dev/null', 'TERM': 'xterm-256color'}
    server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        origin = f'http://127.0.0.1:{port}'
        for _ in range(100):
            try:
                urlopen(origin + '/api/health', timeout=1).close()
                break
            except OSError:
                time.sleep(.1)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            page = browser.new_page(viewport={'width': 1600, 'height': 1000})
            errors, navigations = [], []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('framenavigated', lambda f: navigations.append(f.url) if f != page.main_frame else None)
            page.goto(origin + '/orbit-docking/index.html?' + urlencode({'fixture': manifest['entry']}))
            page.evaluate('window.orbitSpike.ready')
            pane_ids = [m['layout']['pane']['id'] for m in page.evaluate('window.orbitSpike.snapshot().state.monitors')]
            baseline = {}
            for id in pane_ids[:2]:
                frame = page.frame_locator(f'[data-pane-id="{id}"] iframe')
                frame.locator('#draft').fill('draft-' + id)
                baseline[id] = frame.locator('#document-nonce').inner_text()
            snap = page.evaluate('window.orbitSpike.snapshot()')
            saved = snap['state']
            count = len(navigations)
            sash = page.locator('#host .dv-sash').first
            box = sash.bounding_box()
            before_width = page.locator('[data-monitor-id="window-a"]').bounding_box()['width']
            assert box, 'No hit-testable Dockview sash'
            page.mouse.move(box['x'] + box['width']/2, box['y'] + box['height']/2)
            page.mouse.down()
            page.mouse.move(box['x'] + box['width']/2 + 45, box['y'] + box['height']/2, steps=12)
            page.mouse.up()
            page.wait_for_timeout(100)
            after_width = page.locator('[data-monitor-id="window-a"]').bounding_box()['width']
            assert abs(after_width - before_width) > 10, (before_width, after_width)
            page.locator('[data-command="spatial"]').focus()
            page.keyboard.press('Enter')
            page.wait_for_function('orbitSpike.snapshot().state.view === "spatial"')
            page.locator('[data-command="windows"]').focus()
            page.keyboard.press('Enter')
            page.wait_for_function('orbitSpike.snapshot().state.view === "windows"')
            commands = [('tab', {'window_id': 'window-a', 'target_window_id': 'window-b'}), ('select', {'window_id': 'window-a'}), ('dock', {'window_id': 'window-a', 'target_window_id': 'window-b'}), ('float', {'window_id': 'window-a'}), ('resize', {'window_id': 'window-b', 'width': 500}), ('spatial', {}), ('focus', {'window_id': 'window-a'}), ('unfocus', {}), ('windows', {}), ('reorder', {'window_ids': ['window-terminal', 'window-b', 'window-a']}), ('checkpoint', {'state': saved})]
            for command, args in commands:
                current = page.evaluate('([name,args]) => window.orbitSpike.command(name,args)', [command, args])
                assert not errors, (command, errors)
                assert len(navigations) == count, (command, navigations)
                for id in baseline:
                    frame = page.frame_locator(f'[data-pane-id="{id}"] iframe')
                    assert frame.locator('#document-nonce').inner_text() == baseline[id], command
                    assert frame.locator('#draft').input_value() == 'draft-' + id, command
                    for key in ('identity', 'iframeIdentity', 'contentWindowIdentity'):
                        assert snap['panes'][id][key] == current['panes'][id][key], (command, key)
            assert page.evaluate('''async () => {const before=JSON.stringify(orbitSpike.snapshot().state); const state=orbitSpike.snapshot().state; state.monitors[0].layout={type:'tabs',panes:[]}; try {await orbitSpike.command('checkpoint',{state}); return false;} catch {return before===JSON.stringify(orbitSpike.snapshot().state)}}''')
            page.evaluate('([id,url]) => orbitSpike.command("set-pane", {pane_id:id,url})', [pane_ids[0], manifest['entry'] + '?negative=1'])
            frame = page.frame_locator(f'[data-pane-id="{pane_ids[0]}"] iframe')
            assert frame.locator('#document-nonce').inner_text() != baseline[pane_ids[0]]
            assert frame.locator('#draft').input_value() == ''
            assert page.frame_locator(f'[data-pane-id="{pane_ids[1]}"] iframe').locator('#document-nonce').inner_text() == baseline[pane_ids[1]]
            page.evaluate('id => orbitSpike.command("close", {pane_id:id})', pane_ids[0])
            assert page.locator(f'[data-pane-id="{pane_ids[0]}"]').count() == 0
            assert not errors, errors
            print(f'PASS {len(commands)} API continuity transitions, keyboard spatial/windows, pointer sash {before_width}->{after_width}, atomic unsupported rejection, URL/close negatives, Chromium {browser.version}; PTY not exercised')
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
