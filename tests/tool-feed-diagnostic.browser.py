from pathlib import Path
import json, subprocess
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
manifest=json.loads(subprocess.check_output(['python3',str(R/'scripts/plugin_publish.py'),str(R/'apps/hermes-live-tools'),'--id','hermes-live-tools','--version','1.0.0','--title','Hermes Live Tools'],text=True))
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000});errors=[];g.on('pageerror',lambda e:errors.append(str(e)))
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click()
 g.wait_for_timeout(2000);wid=g.evaluate('localStorage.getItem("orbit.workspace.id")')
 assert wid!='eed047a8-e519-495e-a7ca-1c8c150a6ef4'
 def control(ops):
  subprocess.run(['python3',str(R/'scripts/workspace_control.py'),'--workspace',wid,'apply',json.dumps(ops)],check=True,capture_output=True)
 control([{'action':'plugin_install','manifest':manifest},{'action':'plugin_enable','plugin_id':'hermes-live-tools'},{'action':'plugin_window','plugin_id':'hermes-live-tools','settings':{'fontSize':19,'frame':{'x':1220,'y':40,'width':350,'height':380,'z':20}}},{'action':'set_view','view':'windows'}])
 frame=g.frame_locator('iframe[src*="/apps/hermes-live-tools-"]')
 expect(frame.locator('#status')).to_contain_text('Idle',timeout=20000)
 g.get_by_role('textbox',name='Message to Hermes').fill('Use the terminal tool to run python3 -c "import time; time.sleep(3); print(123)" then reply done. Do not modify files or use other tools.')
 def inspect_response(r):
  if '/api/agent' not in r.url:return
  req=r.request.post_data_json or {}
  action=req.get('action');print('API',action,r.status,flush=True)
  if action=='events':
   try:
    text=r.text();print('EVENT STREAM',text[:200] if r.status!=200 else ['data keys: '+str(sorted(json.loads(line[5:]).keys())) for line in text.splitlines() if line.startswith('data:')][:12],flush=True)
   except Exception as e:print(type(e).__name__,flush=True)
 g.on('response',inspect_response)
 g.get_by_role('button',name='Send message to Hermes',exact=True).click()
 g.wait_for_timeout(45000)
 print('WIDGET',frame.locator('#status').inner_text(),'CHAT',g.locator('.agent-status').inner_text(),'ERRORS',errors,flush=True)
 expect(frame.locator('#log')).to_contain_text('terminal',timeout=1000)
 expect(frame.locator('#log')).to_contain_text('Finished',timeout=150000)
 expect(g.locator('.agent-status')).to_have_text('COMPLETED',timeout=180000)
 frame.get_by_role('button',name='Pause',exact=True).click();expect(frame.locator('#status')).to_contain_text('paused')
 frame.get_by_role('button',name='Resume',exact=True).click()
 text=frame.locator('#log').inner_text()
 assert 'time.sleep' not in text and 'print(123)' not in text
 assert not errors,errors
 print('PASS: published sandbox plugin on live server received real terminal start and completion via authenticated SSE; pause/resume works; arguments absent; no page errors.')
 print(text)
 control({'action':'plugin_disable','plugin_id':'hermes-live-tools'})
 expect(g.locator('iframe[src*="/apps/hermes-live-tools-"]')).to_have_count(0,timeout=20000)
 b.close()
