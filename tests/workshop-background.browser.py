from pathlib import Path
import re
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
origin=env['ORBIT_PUBLIC_ORIGIN'].rstrip('/')
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']); g=b.new_page()
 html=g.request.get(origin).text()
 css=re.search(r'<link[^>]*href="([^"]+\.css)"',html).group(1)
 assert '#241b38' in g.request.get(origin+css).text()
 g.route(origin+'/__workshop_bg_test__',lambda r:r.fulfill(content_type='text/html',body=f'<link rel="stylesheet" href="{css}"><div data-monitor-id="d910d4c6-e3e6-4cd1-942f-8ba9d27bba94"><div class="browser-surface"><iframe style="width:370px;height:700px" sandbox="allow-scripts" src="/apps/workspace-workshop-8485a41db0d4c74792caca76/index.html"></iframe></div></div>'))
 g.goto(origin+'/__workshop_bg_test__');g.frame_locator('iframe').locator('h1').wait_for()
 colors=g.locator('[data-monitor-id],.browser-surface,iframe').evaluate_all('(els)=>els.map(e=>getComputedStyle(e).backgroundColor)')
 assert colors==['rgb(36, 27, 56)']*3,colors
 print('PASS: live server CSS and actual sandbox iframe host all use opaque plum rgb(36, 27, 56).')
 b.close()
