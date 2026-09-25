"""Published sandbox browser checks. Failure/stale fixtures exist only in this test."""
from pathlib import Path
import json
import os
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
origin=env['ORBIT_PUBLIC_ORIGIN'].rstrip('/')
entry=os.environ.get('OBSERVATORY_ENTRY','/apps/orbit-observatory-8aa34f2601b1358f33e1a6e5/index.html')
feed=origin+'/apps/orbit-observatory-data/snapshot.json*'
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 g=b.new_page(viewport={'width':1440,'height':1050}); errors=[]
 g.on('pageerror',lambda e:errors.append(str(e)))
 g.route(origin+'/__observatory_test__',lambda r:r.fulfill(content_type='text/html',body='<body style="margin:0"><iframe style="width:100vw;height:100vh;border:0" sandbox="allow-scripts allow-forms allow-modals allow-downloads" src="'+entry+'"></iframe>'))
 g.goto(origin+'/__observatory_test__'); f=g.frame_locator('iframe')
 expect(f.locator('h1')).to_have_text('Observatory.')
 expect(f.locator('#connection')).to_have_text('Live',timeout=20000)
 expect(f.locator('#tokens')).not_to_have_text('—')
 expect(f.locator('#memory')).not_to_have_text('—')
 real=json.loads((R/'.runtime/apps/orbit-observatory-data/snapshot.json').read_text())
 assert all(v=='ok' for v in real['sources'].values())
 f.locator('#scope').select_option('profile'); expect(f.locator('#tokens')).to_have_text(f"{real['usage']['profile']['input']+real['usage']['profile']['output']:,}")
 f.get_by_role('button',name='Machine',exact=True).click();expect(f.locator('[data-section="agent"]')).not_to_be_visible()
 f.get_by_role('button',name='Overview',exact=True).click();expect(f.locator('[data-section="agent"]')).to_be_visible()
 f.locator('#pause').click();expect(f.locator('#connection')).to_have_text('Paused');expect(f.locator('#refresh')).to_be_disabled()
 f.locator('#pause').click();expect(f.locator('#connection')).to_have_text('Live')
 with g.expect_download() as event:f.locator('#export').click()
 downloaded=json.loads(Path(event.value.path()).read_text());assert downloaded['version']==1 and 'host' in downloaded
 g.screenshot(path=str(R/'.runtime/observatory-desktop.png'),full_page=True)
 for width in [390,320]:
  g.set_viewport_size({'width':width,'height':950})
  f.locator('body').evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  assert f.locator('body').evaluate('(e)=>e.scrollWidth<=innerWidth'), f.locator('body').evaluate('(e)=>({width:innerWidth,scroll:e.scrollWidth,overflow:[...document.querySelectorAll("*")].filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>({tag:n.tagName,id:n.id,class:n.className,width:n.clientWidth,scroll:n.scrollWidth,right:n.getBoundingClientRect().right}))})')
  expect(f.locator('#refresh')).to_be_visible()
 g.screenshot(path=str(R/'.runtime/observatory-mobile.png'),full_page=True)
 stale={**real,'updated_at':real['updated_at']-120}
 g.route(feed,lambda r:r.fulfill(json=stale,headers={'Access-Control-Allow-Origin':'*'}))
 f.locator('#refresh').click();expect(f.locator('#connection')).to_have_text('Stale');expect(f.locator('#alerts')).to_contain_text('stale')
 g.unroute(feed);g.route(feed,lambda r:r.fulfill(status=503,body='unavailable',headers={'Access-Control-Allow-Origin':'*'}))
 f.locator('#refresh').click();expect(f.locator('#connection')).to_have_text('Disconnected');expect(f.locator('#alerts')).to_contain_text('retained')
 expect(f.locator('#tokens')).not_to_have_text('—')
 g.unroute(feed);broken={**real,'host':None,'sources':{**real['sources'],'host':'unavailable'}}
 g.route(feed,lambda r:r.fulfill(json=broken,headers={'Access-Control-Allow-Origin':'*'}))
 f.locator('#refresh').click();expect(f.locator('#memory')).to_have_text('—');expect(f.locator('#alerts')).to_contain_text('host source unavailable')
 g.unroute(feed);f.locator('#refresh').click();expect(f.locator('#connection')).to_have_text('Live');expect(f.locator('#memory')).not_to_have_text('—')
 assert not errors,errors
 print('PASS: real published sandbox data, scope switch, filters, pause/resume, JSON download, 390/320px overflow checks, stale and offline states, unavailable-source clearing and recovery; zero JS errors.')
 b.close()
