"""Real deployed UI/native-game test; never makes a Jev provider request."""
import json,hashlib,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1];c=json.loads((R/'.runtime/hermes-doom/config.json').read_text());policy=Path(c['policy']);digest=lambda:hashlib.sha256(policy.read_bytes()).hexdigest();before=digest()
env=dict(l.split('=',1) for l in (R/'.env.deploy').read_text().splitlines() if '=' in l)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page(viewport={'width':1280,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(c['public_origin']);page.get_by_label('Orbit host token').fill(env['ORBIT_TOKEN'].strip().strip('"'));page.locator('#unlockButton').click();expect(page.locator('#arena')).to_be_visible(timeout=20000)
 def wait(predicate):
  end=time.monotonic()+20
  while time.monotonic()<end:
   if predicate():return
   page.wait_for_timeout(200)
  raise AssertionError('Condition timed out: '+page.locator('#error').inner_text())
 page.locator('#start').click();wait(lambda:page.locator('#screen').evaluate('e=>e.naturalWidth>0'))
 s=page.evaluate("api('status')");assert s['game']['mode']=='vizdoom',s['game'];tick=s['game']['tick']
 wait(lambda:page.evaluate("api('status').then(s=>s.game.tick)")>tick+10)
 s=page.evaluate("api('status')");assert s['jev']['calls']==0;assert s['game']['god_mode'] is False;assert s['game']['controls']['freeze_learning'] is True
 wait(lambda:page.locator('.decisionNode').count()==4)
 assert page.evaluate("api('status').then(s=>s.decisions.length)")>0
 expect(page.locator('#decisionGraph')).to_contain_text('Local selected')
 page.locator('#decisionHistory button').first.click();assert not page.locator('#followDecisions').is_checked()
 page.locator('#followDecisions').check()
 page.locator('#pause').click();wait(lambda:page.evaluate("api('status').then(s=>s.paused)"))
 # Drain the one short local action that may have been running when paused.
 page.wait_for_timeout(500);tick=page.evaluate("api('status').then(s=>s.game.tick)");page.wait_for_timeout(600);assert page.evaluate("api('status').then(s=>s.game.tick)")==tick
 page.locator('#jev').click();expect(page.locator('#error')).to_contain_text('Explicit consent');assert page.evaluate("api('status').then(s=>s.jev.calls)")==0
 assert page.evaluate("fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status)")==401
 assert page.evaluate("api('jev',{key:'fixture-key',consent:false,budget:1}).then(()=>false,()=>true)") is True
 page.set_viewport_size({'width':390,'height':844});assert page.locator('body').evaluate('e=>e.scrollWidth<=innerWidth')
 page.set_viewport_size({'width':1280,'height':1000});page.screenshot(path=str(R/'.runtime/hermes-doom/browser-test.png'),full_page=True)
 page.goto(c['orbit_origin']);page.set_content(f'<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups" src="{c["public_origin"]}"></iframe>');expect(page.frame_locator('iframe').get_by_role('heading',name='Hermes plays DOOM')).to_be_visible()
 assert not errors,errors;assert digest()==before
 print(json.dumps({'passed':True,'native_mode':s['game']['mode'],'decisions':s['game']['tick'],'frame_bytes':len(s['frame'])*3//4,'jev_calls':s['jev']['calls'],'tests':'real auth, native frames/advancing actions, pause, consent, unauthorized rejection, mobile, Orbit iframe, frozen policy hash; no JS errors'}))
 b.close()
