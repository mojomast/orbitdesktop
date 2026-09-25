from pathlib import Path
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
origin=env['ORBIT_PUBLIC_ORIGIN'].rstrip('/')
entry='/apps/hermes-live-tools-e097e098480d740f42628431/index.html'
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':500,'height':550});errors=[];g.on('pageerror',lambda e:errors.append(str(e)))
 g.route(origin+'/__scroll_test__',lambda r:r.fulfill(content_type='text/html',body='<iframe sandbox="allow-scripts" style="width:450px;height:500px" src="'+entry+'"></iframe>'))
 g.goto(origin+'/__scroll_test__');f=g.frame_locator('iframe');expect(f.locator('#pause')).to_have_text('Pause')
 def feed(count):
  g.evaluate('''count=>{const events=[];for(let i=0;i<count;i++){events.push({tool:'terminal',event:'tool.started',timestamp:Date.now()/1000-2,error:false});events.push({tool:'terminal',event:'tool.completed',timestamp:Date.now()/1000,duration:2,error:false});}events.push({tool:'web_search',event:'tool.started',timestamp:Date.now()/1000,error:false});document.querySelector('iframe').contentWindow.postMessage({type:'orbit:tool-feed',status:'Live test fixture',events},'*')}''',count)
 feed(25);expect(f.locator('article')).to_have_count(26)
 assert f.locator('#log').evaluate('(e)=>e.scrollHeight-e.clientHeight-e.scrollTop')<2
 expect(f.locator('#summary')).to_contain_text('1 active · 25 completed')
 expect(f.locator('#log')).to_contain_text('Searches the web')
 before=f.locator('[data-start]').inner_text();g.wait_for_timeout(1100);assert before!=f.locator('[data-start]').inner_text()
 f.locator('#follow').uncheck();f.locator('#log').evaluate('e=>e.scrollTop=0');feed(26);expect(f.locator('article')).to_have_count(27);assert f.locator('#log').evaluate('e=>e.scrollTop')==0
 f.locator('#latest').click();assert f.locator('#log').evaluate('e=>e.scrollHeight-e.clientHeight-e.scrollTop')<2
 f.locator('#pause').click();feed(27);expect(f.locator('article')).to_have_count(27);f.locator('#pause').click();expect(f.locator('article')).to_have_count(28)
 assert not errors,errors
 print('PASS: published iframe auto-scroll, manual scroll retention, jump-to-latest, elapsed timer, counts, descriptions, pause/resume; synthetic lifecycle fixtures, no page errors.')
 b.close()
