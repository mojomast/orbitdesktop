import json,time
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1];ORIGIN='https://kimi.tailec998.ts.net:4325';URL='https://kimi.tailec998.ts.net:10448'
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1550,'height':1050});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(ORIGIN,wait_until='domcontentloaded')
 page.set_content('<iframe style="width:1500px;height:1000px;border:0" sandbox="allow-scripts allow-forms allow-modals allow-downloads" src="'+ORIGIN+'/apps/cocs-lattice-lab-aabc58272cbf16d1a97562b0/index.html"></iframe>')
 deadline=time.time()+60;lab=None
 while time.time()<deadline:
  lab=next((f for f in page.frames if f.url.startswith(URL+'/')),None)
  if lab and lab.evaluate('!!window.lab'):break
  page.wait_for_timeout(200)
 assert lab and lab.evaluate('!!window.lab'),errors
 assert lab.locator('#graph circle').count()==7
 lab.locator('#captureScenario').click();assert lab.evaluate('latticeSDK.inspect(window.lab.state).income[0]')==4
 lab.locator('#cutScenario').click();assert lab.evaluate('latticeSDK.inspect(window.lab.state).income[0]')==0
 lab.locator('[data-tab=change]').click();assert lab.locator('#pr').is_disabled()
 denied=lab.evaluate("async()=>{const r=await fetch('https://kimi.tailec998.ts.net:10448/api',{method:'POST',headers:{'Content-Type':'application/json','X-Workshop-Token':window.workshopToken},body:JSON.stringify({op:'publish',id:'0'.repeat(32),confirm:false})});return r.status}");assert denied==400
 report=R/'.runtime/lattice-real-generation.json'
 if report.exists():
  d=json.loads(report.read_text())
  if d['status']=='ready':
   lab.locator('#history').select_option(d['id']);lab.locator('#preview').click();lab.locator('#draftPreview').wait_for(state='visible');lab.locator('#title').fill('Local validation: document Director tick semantics');lab.locator('#approved').check();lab.locator('#pr').click();assert lab.locator('#confirm').is_visible();lab.locator('#cancel').click();print('PASS real generated draft preview and PR confirmation cancelled; no GitHub write')
 lab.locator('[data-tab=topology]').click();page.screenshot(path=str(R/'.runtime/lattice-published-sandbox.png'));assert not errors,errors
 print('PASS published wrapper inside opaque Orbit-style sandbox, authenticated API, topology and denied invalid PR; zero JS errors')
 # Workshop gate is visible and old ready drafts cannot enable publication.
 page.goto('https://kimi.tailec998.ts.net:10446/',wait_until='domcontentloaded');page.locator('#revalidate').wait_for();assert 'Map/navigation PRs are blocked' in page.inner_text('body');assert page.locator('#pr').is_disabled();print('PASS updated Workshop gate UI')
 b.close()
