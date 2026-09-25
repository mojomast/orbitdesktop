import json
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]
c=json.loads((R/'.runtime/plugin-catalog/config.json').read_text())
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 g=b.new_page();g.on('console',lambda m:print(m.type,m.text));g.on('requestfailed',lambda r:print('FAILED',r.url,r.failure))
 u=c['orbit_origin']+'/__plugin_catalog_embed_test__'
 g.route(u,lambda r:r.fulfill(content_type='text/html',body=f'<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups" src="{c["public_origin"]}" style="width:1200px;height:900px"></iframe>'))
 g.goto(c['orbit_origin']);g.set_content(f'<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups" src="{c["public_origin"]}" style="width:1200px;height:900px"></iframe>');g.wait_for_timeout(4000)
 print('FRAMES',[(f.url,f.locator('body').inner_text()[:1200]) for f in g.frames])
 b.close()
