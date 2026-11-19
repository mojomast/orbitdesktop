"""Real pinned download, isolated Orbit API, and browser catalog lifecycle."""
import json, os, secrets, socket, subprocess, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp);feed=root/'feed.json'
    subprocess.run([os.sys.executable,str(ROOT/'scripts/orbit_catalog.py'),'sync','--catalog',str(ROOT/'plugin-catalog'),'--runtime',str(root/'runtime'),'--output',str(feed)],check=True)
    subprocess.run([os.sys.executable,str(ROOT/'scripts/catalog_backend.py'),'orbit-live-telemetry','--catalog',str(ROOT/'plugin-catalog'),'--runtime',str(root/'extensions')],check=True)
    state=json.loads((root/'extensions/state.json').read_text()) if (root/'extensions/state.json').exists() else {'active':{}}
    assert not state['active'], 'Stage must never activate a backend'
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    origin=f'http://127.0.0.1:{port}';token=secrets.token_urlsafe(32)
    env={**os.environ,'PORT':str(port),'ORBIT_TOKEN':token,'ORBIT_RUNTIME_DIR':str(root/'runtime'),'ORBIT_PUBLIC_HOST':''}
    with (root/'server.log').open('w') as log:
        server=subprocess.Popen(['node','--experimental-strip-types','server/index.mjs'],cwd=ROOT,env=env,stdout=log,stderr=log)
        try:
            for attempt in range(100):
                try:
                    urllib.request.urlopen(origin+'/api/health',timeout=1).close();break
                except OSError:
                    if server.poll() is not None:raise RuntimeError((root/'server.log').read_text())
                    time.sleep(.1)
            else:raise RuntimeError('Server not ready')
            with sync_playwright() as p:
                browser=p.chromium.launch(headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1000});errors=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.route('**/orbit-plugin-catalog.json',lambda r:r.fulfill(status=404,body=''))
                page.route('**/orbit-community-catalog.json',lambda r:r.fulfill(content_type='application/json',body=feed.read_text()))
                # The endpoint is deliberately unavailable: connection must not claim health.
                page.route('https://telemetry.example.invalid/**',lambda r:r.abort())
                page.goto(origin,wait_until='networkidle')
                page.get_by_role('button',name='Connect local host',exact=True).click()
                page.get_by_role('textbox',name='Host session token').fill(token)
                page.get_by_role('button',name='Unlock local host',exact=True).click()
                page.keyboard.press('Control+Alt+p');dialog=page.get_by_role('dialog',name='Workspace plugins',exact=True)
                expect(dialog.locator('.plugin-card')).to_have_count(1)
                expect(dialog).to_contain_text('backend not connected')
                dialog.get_by_text('Trusted backend · separate setup required',exact=True).click()
                expect(dialog).to_contain_text('not a sandbox')
                dialog.get_by_role('button',name='Install plugin orbit-live-telemetry',exact=True).click()
                expect(dialog.get_by_role('button',name='Enable plugin orbit-live-telemetry',exact=True)).to_be_enabled()
                dialog.get_by_role('button',name='Enable plugin orbit-live-telemetry',exact=True).click()
                expect(page.frame_locator('iframe[src*="/apps/orbit-live-telemetry-"]').get_by_role('heading',name='Live Telemetry')).to_be_visible()
                def prompts(d):d.accept('https://telemetry.example.invalid' if d.type=='prompt' else None)
                page.on('dialog',prompts)
                dialog.get_by_role('button',name='Connect backend orbit-live-telemetry',exact=True).click()
                expect(dialog).to_contain_text('Endpoint configured · health not checked')
                expect(page.locator('iframe[src="https://telemetry.example.invalid/"]')).to_have_count(1)
                page.remove_listener('dialog',prompts)
                def disconnect(d):d.accept('' if d.type=='prompt' else None)
                page.on('dialog',disconnect)
                dialog.get_by_role('button',name='Connect backend orbit-live-telemetry',exact=True).click()
                expect(page.frame_locator('iframe[src*="/apps/orbit-live-telemetry-"]').get_by_role('heading',name='Live Telemetry')).to_be_visible()
                page.remove_listener('dialog',disconnect)
                page.set_viewport_size({'width':390,'height':844})
                assert dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
                page.screenshot(path='/tmp/orbit-backend-catalog-mobile.png')
                page.once('dialog',lambda d:d.accept())
                dialog.get_by_role('button',name='Remove plugin orbit-live-telemetry',exact=True).click()
                expect(dialog.get_by_role('button',name='Install plugin orbit-live-telemetry',exact=True)).to_be_enabled()
                assert not errors,errors
                browser.close()
            print('PASS: GitHub-pinned telemetry UI and backend stage without execution; real authenticated install/enable/connect/disconnect/remove, mobile layout, no browser errors. Unavailable endpoint was explicitly not reported healthy.')
        finally:server.terminate();server.wait(timeout=10)
