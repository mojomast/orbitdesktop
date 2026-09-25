from pathlib import Path
import sys
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[2]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1400,'height':1000});errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='domcontentloaded')
 page.set_content('<iframe sandbox="allow-scripts allow-forms allow-modals allow-downloads" style="width:1300px;height:900px" src="'+env['ORBIT_PUBLIC_ORIGIN']+sys.argv[1]+'"></iframe>')
 shell=page.frame_locator('iframe');viewer=shell.frame_locator('#active')
 viewer.locator('#status').filter(has_text='Vehicles / Puma').wait_for(timeout=60000)
 shell.locator('#update').click();shell.locator('#confirm').click()
 shell.locator('#message').filter(has_text='Loaded GitHub').wait_for(timeout=180000)
 viewer=shell.frame_locator('#active');viewer.locator('#search').fill('blood')
 viewer.locator('#list button').click();viewer.locator('#status').filter(has_text='Maps / Blood').wait_for(timeout=60000)
 viewer.locator('#wire').check();viewer.locator('#top').click()
 page.screenshot(path=str(R/'apps/cocs-viewer/update-embedded.png'))
 assert not errors,errors
 print('PASS workspace-style sandbox: GitHub rebuild, map selection, wireframe, camera, screenshot; no JS errors',flush=True)
 b.close()
