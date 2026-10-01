"""Isolated Vite + real desktop renderer fixture; owner API responses are mocked.

No owner runtime, terminals or providers. Exercises persisted host URLs, actual
Windows/Spatial/focus reconciliation, modal pin requests, registry deep links,
subscription cardinality and close/in-flight request cleanup.
"""
import copy
import json
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
with tempfile.TemporaryDirectory(prefix='orbit-host-surfaces-', dir='/tmp/opencode') as temporary:
    root = Path(temporary)
    for name in ('src', 'contracts', 'public', 'server', 'scripts', 'docs'):
        shutil.copytree(ROOT / name, root / name)
    for name in ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js'):
        shutil.copy2(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    ids = [str(uuid.uuid4()) for _ in range(6)]
    workspace = str(uuid.uuid4())
    state = {'version': 1, 'selected': ids[0], 'arc': 14, 'view': 'windows', 'monitors': []}
    for i, surface in enumerate(('outputs', 'activity')):
        state['monitors'].append({'id': ids[i], 'name': surface, 'diagonal': 32,
            'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0,
            'offset': 0, 'fontSize': 19,
            'frame': {'x': 30 + i * 650, 'y': 30, 'width': 620, 'height': 510, 'z': i + 1},
            'layout': {'type': 'pane', 'pane': {'id': ids[i + 2], 'kind': 'browser',
                                               'url': f'orbit://surface/{surface}'}}})
    spare = copy.deepcopy(state['monitors'][0])
    spare.update(id=ids[4], name='Spare')
    spare['layout']['pane'].update(id=ids[5], url='orbit://welcome')
    spare['frame'].update(x=20, y=600)
    state['monitors'].append(spare)
    revision = 1
    shelf_calls = []
    pending_shelf = []
    hold_shelf = False
    server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1',
                               '--port', str(port), '--strictPort'], cwd=root,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(150):
            if server.poll() is not None:
                raise RuntimeError('Isolated Vite exited')
            try:
                urllib.request.urlopen(origin, timeout=1).close()
                break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Isolated Vite readiness timeout')
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=['--no-sandbox',
                '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1600, 'height': 1000})
            context.add_init_script('''
              window.__activitySets=[];
              const add=Set.prototype.add;
              Set.prototype.add=function(value){
                if(typeof value==='function' && new Error().stack.includes('/src/agent-activity.ts') && !window.__activitySets.includes(this)) window.__activitySets.push(this);
                return add.call(this,value);
              };
            ''' + f"localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.menu.pinned','true');localStorage.setItem('orbit.workspace.id',{json.dumps(workspace)});if(!localStorage.getItem('orbit.workspace.v1'))localStorage.setItem('orbit.workspace.v1',JSON.stringify({json.dumps(state)}));")
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))

            def reply(route, data):
                route.fulfill(status=200, content_type='application/json', body=json.dumps(data))

            def api(route):
                global state, revision
                body = route.request.post_data_json or {}
                if route.request.url.endswith('/api/auth'):
                    return reply(route, {})
                if route.request.url.endswith('/api/workspace/events'):
                    return reply(route, {'workspace_id': workspace, 'events': [], 'cursor': 0,
                                         'has_more': False, 'reset_required': False})
                action = body.get('action')
                if action == 'shelf':
                    shelf_calls.append({'auth': route.request.headers.get('authorization'), 'body': body})
                    if hold_shelf:
                        pending_shelf.append(route)
                        return
                    return reply(route, {'items': [{'title': 'Fixture output', 'url': '/apps/fixture/index.html'}]})
                if action == 'sync':
                    state = copy.deepcopy(body['state'])
                    revision += 1
                return reply(route, {'state': state, 'revision': revision, 'observed_revision': revision})

            page.route('**/api/**', api)
            # Seed once; reload must consume the actual persisted layout.
            page.goto(origin)

            def hosts_ready():
                try:
                    expect(page.locator('[data-host-surface="outputs"] .outputs-view')).to_have_count(1)
                except AssertionError as error:
                    raise AssertionError({'errors': errors, 'state': page.evaluate('localStorage.getItem("orbit.workspace.v1")'), 'body': page.locator('body').inner_text()}) from error
                expect(page.locator('[data-host-surface="activity"] .agent-overview-list')).to_have_count(1)
                expect(page.locator('.pane iframe')).to_have_count(0)

            def unlock():
                page.keyboard.press('Escape')
                page.get_by_role('button', name='Connect local host', exact=True).click()
                page.get_by_role('textbox', name='Host session token').fill('fixture-token')
                page.get_by_role('button', name='Unlock local host', exact=True).click()
                expect(page.locator('[data-host-surface="outputs"]')).to_contain_text('Fixture output')

            hosts_ready()
            assert not shelf_calls, 'Persisted URL must not supply host authority'
            expect(page.locator('[data-host-surface="outputs"]')).to_contain_text('Connect host')
            unlock()
            assert shelf_calls[-1]['auth'] == 'Bearer fixture-token'
            assert 'token' not in json.dumps(state), 'Runtime token leaked to layout'
            page.evaluate('''async()=>{
              const m=await import('/src/agent-activity.ts');
              window.__focus=[];
              window.__agent=m.registerActivity('fixture-agent',()=>window.__focus.push('pane'),{
                focusMode:mode=>window.__focus.push(mode),modesAvailable:()=>true});
              window.__agent.update({title:'Fixture agent',task:'Fixture task',status:'Working',mode:'normal'});
            }''')
            expect(page.locator('[data-host-surface="activity"]')).to_contain_text('Fixture task')
            page.get_by_role('button', name='Focus workbench mode in Fixture agent').click()
            assert page.evaluate('window.__focus') == ['pane', 'workbench']
            page.evaluate('''()=>{
              window.__hostNodes=[...document.querySelectorAll('[data-host-surface]')];
              window.__list=document.querySelector('.agent-overview-list');
            }''')

            def verify():
                assert page.evaluate('window.__hostNodes.every(n=>n.isConnected && document.querySelector(`[data-host-surface="${n.dataset.hostSurface}"]`)===n)')
                assert page.evaluate('window.__activitySets.length===1 && window.__activitySets[0].size===1'), 'Activity subscriptions multiplied'
                assert not errors, errors

            for cycle in range(3):
                page.get_by_role('button', name='Switch to spatial view', exact=True).click()
                verify()
                page.get_by_role('button', name='Focus selected display', exact=True).click()
                expect(page.locator('.focus-host .monitor')).to_have_count(1)
                verify()
                page.get_by_role('button', name='Exit focus view', exact=True).click()
                page.get_by_role('button', name='Switch to movable windows', exact=True).click()
                verify()
                # New remote metadata revision exercises real layout reconciliation.
                page.wait_for_timeout(1600)
                state['monitors'].reverse()
                state['monitors'][0]['name'] = f'Reconciled {cycle}'
                revision += 1
                page.wait_for_function('name=>JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors[0].name===name', arg=f'Reconciled {cycle}')
                verify()
                before = len(shelf_calls)
                page.evaluate('window.dispatchEvent(new Event("orbit-host-connected"))')
                page.wait_for_function('document.querySelector(".outputs-list").textContent.includes("Fixture output")')
                page.wait_for_timeout(400)
                assert len(shelf_calls) == before + 1, 'Outputs connection listeners multiplied'

            page.reload()
            hosts_ready()
            expect(page.locator('[data-host-surface="outputs"]')).to_contain_text('Connect host')
            assert page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors.filter(m=>m.layout.pane.url.startsWith("orbit://surface/")).length===2')
            unlock()
            page.evaluate('''async()=>{
              const m=await import('/src/agent-activity.ts');
              window.__agent=m.registerActivity('fixture-agent',()=>{});
              window.__list=document.querySelector('.agent-overview-list');
            }''')
            # Close with an owner request in flight: late data must not repopulate.
            hold_shelf = True
            page.locator('[data-host-surface="outputs"]').get_by_role('button', name='Refresh published outputs').click()
            page.wait_for_timeout(500)
            assert pending_shelf, 'No in-flight shelf request to test'
            page.locator(f'.monitor[data-monitor-id="{ids[0]}"] .window-close').click()
            page.get_by_role('button', name='Confirm change', exact=True).click()
            expect(page.locator('[data-host-surface="outputs"]')).to_have_count(0)
            for route in pending_shelf:
                try:
                    reply(route, {'items': [{'title': 'Late result', 'url': '/apps/fixture/late.html'}]})
                except Exception:
                    pass  # Chromium may have already cancelled the aborted route.
            pending_shelf.clear()
            hold_shelf = False
            before = len(shelf_calls)
            page.evaluate('window.dispatchEvent(new Event("orbit-host-connected"))')
            page.wait_for_timeout(300)
            assert len(shelf_calls) == before, 'Closed Outputs retained a connection listener'
            page.locator(f'.monitor[data-monitor-id="{ids[1]}"] .window-close').click()
            page.get_by_role('button', name='Confirm change', exact=True).click()
            expect(page.locator('[data-host-surface="activity"]')).to_have_count(0)
            assert page.evaluate('window.__activitySets[0].size===0'), 'Closed Activity retained registry subscription'
            page.evaluate('window.__agent.update({task:"After close"})')
            assert 'After close' not in page.evaluate('window.__list.textContent')
            # Existing modal APIs and the exact shell event contract.
            page.evaluate('''async()=>{
              window.__requests=[];
              window.addEventListener('orbit-open-host-surface',e=>window.__requests.push(e.detail));
              const h=await import('/src/host-surfaces.ts');
              if(h.hostSurfaceId('orbit://surface/outputs?token=x')!==null || h.hostSurfaceId('orbit://surface/arbitrary')!==null) throw Error('Loose allowlist');
              const m=await import('/src/agent-activity.ts');m.openAgentOverview();
            }''')
            page.get_by_role('button', name='Open Workspace Activity as window').click()
            expect(page.locator('.agent-overview')).to_have_count(0)
            page.evaluate('''async()=>{const m=await import('/src/hermes-surfaces.ts');await m.showShelf(()=> 'fixture-token');}''')
            page.get_by_role('button', name='Open Outputs as window').click()
            assert page.evaluate('window.__requests') == [{'id': 'activity'}, {'id': 'outputs'}]
            page.wait_for_timeout(200)
            assert page.evaluate('window.__activitySets[0].size===document.querySelectorAll("[data-host-surface=activity] .agent-overview-list").length'), 'Pinning left a modal subscription behind'
            assert not errors, errors
            browser.close()
            print('PASS host Outputs/Activity: reload, exact routes, renderer/focus/reconciliation continuity, owner token callback, deep links, modal pin requests, subscription cleanup and request abort')
    finally:
        server.terminate()
        server.wait(timeout=10)
