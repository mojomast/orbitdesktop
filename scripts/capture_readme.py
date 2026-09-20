"""Capture README images in an isolated browser context with synthetic demo content."""
from pathlib import Path
import json,subprocess
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1];dest=R/'docs/images';dest.mkdir(exist_ok=True)
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
manifest=json.loads(subprocess.check_output(['python3',str(R/'scripts/plugin_publish.py'),str(R/'examples/plugins/notes'),'--id','notes','--version','1.0.0','--title','Workspace notes'],text=True))
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1440,'height':960},device_scale_factor=1)
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle');g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(1800)
 wid=g.evaluate('localStorage.getItem("orbit.workspace.id")')
 def control(op):return json.loads(subprocess.check_output(['python3',str(R/'scripts/workspace_control.py'),'--workspace',wid,'apply',json.dumps(op)],text=True))
 result=control([{'action':'plugin_install','manifest':manifest,'config':{'title':'Your workspace, your tools','message':'Built by Hermes. Configured live. Restorable from checkpoints.'}},{'action':'plugin_enable','plugin_id':'notes'},{'action':'set_view','view':'windows'},{'action':'sidebar','hidden':True}])
 ops=[]
 for i,m in enumerate(result['state']['monitors']):
  ops.append({'action':'update_window','window_id':m['id'],'frame':{'x':20+(i%2)*685,'y':30+(i//2)*375,'width':660,'height':355,'z':i+1},'fontSize':14})
 control(ops);g.wait_for_timeout(1800)
 expect(g.frame_locator('iframe[src*="/apps/notes-"]').locator('h1')).to_have_text('Your workspace, your tools')
 g.screenshot(path=str(dest/'workspace.png'))
 g.keyboard.press('Control+Alt+p');expect(g.get_by_role('dialog',name='Workspace plugins')).to_be_visible();g.screenshot(path=str(dest/'plugins.png'));g.get_by_role('button',name='Close workspace plugins').click()
 g.get_by_role('button',name='Focus Display 03',exact=True).click(force=True);g.get_by_role('button',name='Hermes tools and conversations').click();g.get_by_role('button',name='Open workspace checkpoints').click();expect(g.get_by_role('dialog',name='Workspace checkpoints')).to_contain_text('Before');g.screenshot(path=str(dest/'checkpoints.png'))
 b.close()
 print('Captured workspace.png, plugins.png, checkpoints.png in clean demo context; no conversations or shell commands used.')
