from pathlib import Path
import json,sys
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[2]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1400,'height':1000},accept_downloads=True)
 errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(env['ORBIT_PUBLIC_ORIGIN']+sys.argv[1],wait_until='networkidle')
 frame=page.frame_locator('#active')
 frame.locator('#status').filter(has_text='Vehicles / Puma').wait_for(timeout=60000)
 page.locator('#update').click();page.locator('#confirm').click()
 page.wait_for_function("!document.getElementById('update').disabled",timeout=180000)
 status=page.locator('#message').inner_text();print(status,flush=True)
 assert status.startswith('Loaded GitHub'),status
 frame=page.frame_locator('#active')
 frame.locator('#status').filter(has_text='Vehicles / Puma').wait_for(timeout=60000)
 asset_frame=page.locator('#active').element_handle().content_frame()
 assets=asset_frame.evaluate('window.cocsViewer.catalog')
 for asset in assets:
  asset_frame.evaluate('(id)=>window.cocsViewer.select(id)',asset['id'])
  asset_frame.wait_for_function('window.cocsViewer.ready',timeout=60000)
  result=asset_frame.evaluate('window.cocsViewer.inspect()')
  assert result['meshes']>0 and result['triangles']>0,result
 print('PASS',len(assets),'live GitHub assets',flush=True)
 with page.expect_download() as dl:page.locator('#download').click()
 target=R/'apps/cocs-viewer/download-test.html';dl.value.save_as(target)
 offline=b.new_page();offline.goto(target.as_uri());offline.wait_for_function('window.cocsViewer?.ready',timeout=60000)
 print('PASS standalone saved HTML',flush=True);offline.close()
 # Network failure must leave the active collection intact.
 page.route('https://api.github.com/**',lambda route:route.abort())
 page.locator('#update').click();page.locator('#confirm').click()
 page.wait_for_function("!document.getElementById('update').disabled",timeout=30000)
 assert 'previous collection retained' in page.locator('#message').inner_text()
 assert asset_frame.evaluate('window.cocsViewer.ready')
 print('PASS failed update retained current viewer',flush=True)
 page.unroute('https://api.github.com/**')
 page.locator('#reset').click()
 page.frame_locator('#active').locator('#status').filter(has_text='Vehicles / Puma').wait_for(timeout=60000)
 assert page.locator('#download').is_disabled()
 print('PASS restore bundled snapshot',flush=True)
 assert not errors,errors
 page.screenshot(path=str(R/'apps/cocs-viewer/update-preview.png'))
 print('PASS no JavaScript errors',flush=True)
 b.close()
