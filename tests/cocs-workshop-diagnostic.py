from playwright.sync_api import sync_playwright
import time
with sync_playwright() as p:
 print('launch',flush=True)
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page();page.on('pageerror',lambda e:print('JS',str(e),flush=True));page.on('console',lambda e:print('CONSOLE',e.type,e.text[:300],flush=True));page.on('requestfailed',lambda r:print('FAIL',r.url,r.failure,flush=True))
 print('navigate',flush=True);page.goto('https://kimi.tailec998.ts.net:10446/',wait_until='domcontentloaded',timeout=20000)
 print('loaded',flush=True);page.wait_for_timeout(8000)
 for f in page.frames:print('FRAME',f.url,f.locator('body').inner_text(timeout=3000)[:900],flush=True)
 b.close()
