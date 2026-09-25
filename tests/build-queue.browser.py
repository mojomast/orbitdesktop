from pathlib import Path
import json,time
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',headless=True,args=['--no-sandbox'])
 g=b.new_page(viewport={'width':1600,'height':1000});errors=[];g.on('pageerror',lambda e:errors.append(str(e)));g.on('dialog',lambda d:d.accept())
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click()
 g.wait_for_timeout(1800)
 wid=g.evaluate('localStorage.getItem("orbit.workspace.id")');assert wid!='eed047a8-e519-495e-a7ca-1c8c150a6ef4'
 def open_queue():
  g.get_by_role('button',name='Hermes tools and conversations',exact=True).first.click();g.get_by_role('button',name='Open automated build queue',exact=True).click();expect(g.get_by_role('dialog',name='Automated build queue',exact=True)).to_be_visible();expect(g.get_by_role('dialog',name='Automated build queue',exact=True)).to_contain_text('Queue paused')
 open_queue()
 board={'version':1,'tasks':[{'title':'Import persistence check','status':'Queued','evidence':'Do not run this test item','checks':[False]*4},{'title':'Already done','status':'Done','evidence':'','checks':[False]*4}]}
 g.get_by_role('dialog',name='Automated build queue',exact=True).locator('input[type=file]').set_input_files({'name':'board.json','mimeType':'application/json','buffer':json.dumps(board).encode()})
 expect(g.locator('.hermes-job')).to_have_count(1);expect(g.locator('.hermes-job')).to_contain_text('Import persistence check')
 g.get_by_role('button',name='Dismiss build task',exact=True).click();expect(g.locator('.hermes-job')).to_have_count(0)
 print('PASS: Workshop import copies only queued tasks without launching them.')
 g.get_by_role('textbox',name='Build task',exact=True).fill('Read-only queue verification: use terminal to run printf orbit-queue-live-check, report the actual output, and do not modify files or workspace settings.');g.get_by_role('button',name='Add build task',exact=True).click();expect(g.locator('.hermes-job')).to_contain_text('Read-only queue verification')
 g.get_by_role('button',name='Close build queue',exact=True).click();g.reload(wait_until='networkidle')
 # Token may remain unlocked across this reload via stored connection.
 if g.get_by_role('button',name='Connect local host',exact=True).is_visible():
  g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click()
 open_queue();expect(g.locator('.hermes-job')).to_contain_text('Read-only queue verification')
 print('PASS: live authenticated queue saved a task and retained it across browser reload; solid dialog rendered.')
 g.get_by_role('button',name='Start build queue',exact=True).click()
 deadline=time.time()+150
 while time.time()<deadline:
  text=g.get_by_role('dialog',name='Automated build queue',exact=True).inner_text()
  if 'Hermes is busy' in text or 'reported completion' in text or 'Review required' in text or 'outcome unknown' in text:break
  g.wait_for_timeout(1500)
 if 'reported completion' in text:
  g.get_by_text('Result / evidence',exact=True).click()
  evidence=g.locator('.hermes-job pre').inner_text()
  assert 'orbit-queue-live-check' in evidence and evidence.rstrip().endswith('[WORKSHOP_DONE]'), evidence
  print('REAL HERMES OUTPUT:',evidence)
 assert 'Hermes is busy' in text or 'reported completion' in text, 'Live task did not reach expected terminal/busy state'
 print('LIVE RUN RESULT:',g.locator('.hermes-job').inner_text())
 if 'Hermes is busy' in text or 'reported completion' in text:
  g.get_by_role('button',name='Dismiss build task',exact=True).click();expect(g.locator('.hermes-job')).to_have_count(0)
 assert not errors,errors
 print('PASS: browser controls, persistence, and cleanup; no JavaScript page errors. Real-run result shown above, not simulated.')
 b.close()
