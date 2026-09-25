from pathlib import Path
import json,sys,time,urllib.request,urllib.error
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1];URL='https://kimi.tailec998.ts.net:10446'
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1600,'height':1000});errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 env=dict(l.split('=',1) for l in (R/'.env.deploy').read_text().splitlines() if '=' in l)
 entry=env['ORBIT_PUBLIC_ORIGIN']+'/apps/cocs-viewer-7b0acda75f4ab60e72fb2113/index.html' if '--published' in sys.argv else URL+'/'
 page.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='domcontentloaded') if '--published' in sys.argv else page.goto(URL+'/health',wait_until='domcontentloaded')
 page.set_content('<iframe sandbox="allow-scripts allow-forms allow-modals allow-downloads" style="width:1550px;height:940px" src="'+entry+'"></iframe>',wait_until='domcontentloaded')
 workshop=page.frame_locator('iframe')
 if '--published' in sys.argv:workshop=workshop.frame_locator('iframe')
 viewer=workshop.frame_locator('#view').frame_locator('#active')
 viewer.locator('#status').filter(has_text='Vehicles / Puma').wait_for(timeout=90000)
 workshop.locator('#asset').filter(has_text='vehicle:puma').wait_for()
 assert not workshop.locator('#generate').is_disabled()
 assert workshop.locator('#pr').is_disabled()
 print('PASS nested sandbox, selected asset context, authenticated workshop, PR gated before preview',flush=True)
 if '--resume' in sys.argv:
  options=workshop.locator('#history option').evaluate_all('(els)=>els.map(e=>({value:e.value,text:e.textContent}))')
  ready=next(o['value'] for o in options if ' · ready · ' in o['text'])
  workshop.locator('#history').select_option(ready)
  workshop.locator('#status').filter(has_text='ready').wait_for()
 if '--generate' in sys.argv:
  workshop.locator('#prompt').fill('This is a local-only end-to-end workshop test. Change only the Puma body paint to a dark purple (#4c286b), preserving dimensions and all other behavior. Inspect the existing vehicle builder and make the smallest appropriate source edit. Do not commit, push, or open a PR.')
  workshop.locator('#generate').click()
  deadline=time.time()+480
  while time.time()<deadline:
   status=workshop.locator('#status').inner_text();print('Poll:',status,flush=True)
   if status.startswith(('ready','blocked')):break
   page.wait_for_timeout(2000)
  print('Actual Hermes draft status:',status,flush=True)
  if not status.startswith('ready'):raise RuntimeError(status)
 if '--generate' in sys.argv or '--resume' in sys.argv:
  workshop.locator('#preview').click()
  preview=workshop.frame_locator('#view')
  preview.locator('#status').filter(has_text='Vehicles / Puma').wait_for(timeout=90000)
  workshop.locator('#approved').check();workshop.locator('#title').fill('Test draft — do not publish')
  workshop.locator('#pr').click();workshop.locator('#confirm').wait_for(state='visible');workshop.locator('#dismiss').click()
  print('PASS real prompt -> source edit -> validated 3D preview -> review -> PR confirmation (cancelled; no GitHub write)',flush=True)
 page.screenshot(path=str(R/'.runtime/cocs-workshop/browser-test.png'))
 assert not errors,errors
 print('PASS no JavaScript exceptions',flush=True)
 b.close()
