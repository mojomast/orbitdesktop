"""Exercise the real read-only service UI with real /proc data; proxy identity is test-injected."""
import importlib.util
from pathlib import Path
import threading
import time
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('telemetry',ROOT/'packages/orbit-live-telemetry/backend/main.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
config={'host':'placeholder','owner':'test-owner','orbitOrigin':'https://orbit.example.com'}
server=m.ThreadingHTTPServer(('127.0.0.1',0),m.handler(config))
# Handler closes over host at creation: assign a newly constructed class using the actual port.
config['host']=f'127.0.0.1:{server.server_port}';server.RequestHandlerClass=m.handler(config)
server.metrics_lock=threading.Lock();server.metrics,previous=m.sample();stopped=threading.Event()
def sampling():
    global previous
    while not stopped.wait(.25):
        data,previous=m.sample(previous)
        with server.metrics_lock:server.metrics=data
threading.Thread(target=sampling,daemon=True).start()
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
        page=browser.new_page(extra_http_headers={'Tailscale-User-Login':'test-owner'},viewport={'width':390,'height':844});errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(f'http://127.0.0.1:{server.server_port}',wait_until='networkidle')
        expect(page.locator('#status')).to_contain_text('Live')
        expect(page.locator('#memory')).to_contain_text('GiB')
        expect(page.locator('#cpu')).to_contain_text('%',timeout=10000)
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.get_by_role('button',name='Pause',exact=True).click()
        expect(page.locator('#status')).to_contain_text('Paused')
        page.get_by_role('button',name='Resume',exact=True).click()
        expect(page.locator('#status')).to_contain_text('Live')
        page.route('**/api/metrics',lambda r:r.abort())
        expect(page.locator('#status')).to_contain_text('Disconnected',timeout=10000)
        expect(page.locator('#memory')).to_have_text('—')
        page.unroute('**/api/metrics')
        expect(page.locator('#status')).to_contain_text('Live',timeout=10000)
        page.screenshot(path='/tmp/orbit-portable-telemetry-mobile.png')
        assert not errors,errors
        browser.close()
    print('PASS: real telemetry HTTP/UI and real host CPU/RAM/load, pause/resume, failure clears values, recovery, 390px layout; no JavaScript errors. Tailscale identity was injected only for this isolated test.')
finally:
    stopped.set();server.shutdown();server.server_close()
