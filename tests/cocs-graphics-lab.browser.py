from pathlib import Path
import json,sys,time
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]
URL='https://kimi.tailec998.ts.net:10447'
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1600,'height':1000});errors=[];shader_errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('console',lambda m:shader_errors.append(m.text) if m.type=='error' and 'status of 400' not in m.text else None)
 entry=sys.argv[1] if len(sys.argv)>1 else URL+'/'
 if len(sys.argv)>1:
  from urllib.parse import urlsplit
  u=urlsplit(entry);page.goto(u.scheme+'://'+u.netloc,wait_until='domcontentloaded')
 else:page.goto(URL+'/health')
 page.set_content('<iframe sandbox="allow-scripts allow-forms allow-modals allow-downloads" style="width:1560px;height:950px;border:0" src="'+entry+'"></iframe>')
 page.wait_for_timeout(1000)
 def get_lab():
  return next((f for f in page.frames if f.url.startswith(URL+'/') and '/health' not in f.url),None)
 deadline=time.time()+90
 while time.time()<deadline:
  lab=get_lab()
  if lab and lab.evaluate('!!window.graphicsLab?.ready'):break
  page.wait_for_timeout(300)
 assert lab and lab.evaluate('window.graphicsLab?.ready'),(errors,shader_errors)
 lab.wait_for_function('window.graphicsLab.frames>3',timeout=90000)
 info=lab.evaluate('window.graphicsLab.inspect()');assert len(info['bots'])==6 and all(x['rig'] for x in info['bots']),info
 print('PASS actual COCS character rigs, six frozen poses, WebGL frame rendering',flush=True)
 before=lab.locator('#canvas').screenshot()
 lab.locator('#preset').select_option('Void phase');page.wait_for_timeout(700)
 after=lab.locator('#canvas').screenshot();assert before!=after
 assert lab.evaluate('window.graphicsLab.recipe.warp')==.05
 lab.locator('#bypass').check();page.wait_for_timeout(400);assert lab.locator('#canvas').screenshot()!=after
 lab.locator('#bypass').uncheck();lab.locator('#split').check();page.wait_for_timeout(400)
 assert lab.locator('#compareLabel').is_visible()
 lab.locator('#split').uncheck()
 frozen=lab.evaluate('window.graphicsLab.bots')
 lab.locator('#eye').click();initial=lab.evaluate('window.graphicsLab.inspect().camera')
 lab.locator('#canvas').click(position={'x':450,'y':350});page.keyboard.down('w');page.wait_for_timeout(700);page.keyboard.up('w')
 assert lab.evaluate('window.graphicsLab.inspect().camera')!=initial
 assert lab.evaluate('window.graphicsLab.bots')==frozen
 lab.locator('#focus').select_option('2');assert lab.evaluate('window.graphicsLab.inspect().target[1]')>2
 lab.locator('#home').click();lab.locator('#scene').select_option('night');page.wait_for_timeout(300)
 assert lab.evaluate('window.graphicsLab.scene')=='night'
 lab.locator('#scene').select_option('studio')
 print('PASS recipe changes pixels, bypass/split, eye/focus/free camera and unchanged bot poses',flush=True)
 lab.locator('#variants').click();assert lab.locator('#candidates button').count()==4;lab.locator('#candidates button').nth(2).click()
 lab.locator('#brief').click();text=lab.locator('#briefText').input_value();assert 'Fragment shader:' in text and 'Powerup/event: powerup:' in text and len(text)<8000
 with page.expect_download() as d:lab.locator('#export').click()
 data=json.loads(Path(d.value.path()).read_text());assert data['schema']==1 and data['recipe']['warp']>=0
 lab.locator('#import').set_input_files({'name':'roundtrip.json','mimeType':'application/json','buffer':json.dumps(data).encode()})
 lab.locator('#saveStatus').filter(has_text='Imported.').wait_for(timeout=10000)
 lab.locator('#recipeName').fill('Browser verification recipe')
 lab.locator('#save').click();lab.locator('#saveStatus').filter(has_text='Saved privately').wait_for(timeout=15000)
 saved_id=lab.locator('#saved').input_value();assert saved_id
 lab.locator('#reset').click();lab.locator('#saved').select_option(saved_id);assert lab.evaluate('window.graphicsLab.recipe')==data['recipe']
 print('PASS four variations, shader change brief, JSON export/import and authenticated recipe save/load',flush=True)
 lab.locator('#reviewToggle').click();assert lab.locator('#pr').is_disabled();assert lab.locator('#preview').is_disabled()
 # Real service rejects publishing without a validated approved draft.
 denied=lab.evaluate("async()=>{const r=await fetch('https://kimi.tailec998.ts.net:10447/api',{method:'POST',headers:{'Content-Type':'application/json','X-Workshop-Token':window.graphicsToken},body:JSON.stringify({op:'publish',id:'0'.repeat(32),confirm:false})});return r.status}")
 assert denied==400
 print('PASS PR UI disabled without validated draft; backend rejects invalid publication',flush=True)
 lab.locator('#reviewToggle').click();lab.locator('#preset').select_option('Shield frost');lab.locator('#home').click();page.wait_for_timeout(700)
 (R/'.runtime/cocs-graphics-lab').mkdir(exist_ok=True)
 page.screenshot(path=str(R/'.runtime/cocs-graphics-lab/browser-test.png'))
 assert not errors,errors
 assert not shader_errors,shader_errors
 print('PASS zero JavaScript or shader errors; screenshot saved',flush=True)
 b.close()
