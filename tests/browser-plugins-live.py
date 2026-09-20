from pathlib import Path
import json,subprocess
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1];env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
manifest=json.loads(subprocess.check_output(['python3',str(R/'scripts/plugin_publish.py'),str(R/'examples/plugins/notes'),'--id','notes','--version','1.0.0','--title','Workspace notes'],text=True))
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000});errors=[];g.on('pageerror',lambda e:errors.append(str(e)))
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle');g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(1800)
 wid=g.evaluate('localStorage.getItem("orbit.workspace.id")');marker=g.evaluate('window.pluginTestMarker="same-document"')
 def manager():
  g.get_by_role('button',name='Focus Display 03',exact=True).click(force=True);g.get_by_role('button',name='Hermes tools and conversations').click();g.get_by_role('button',name='Manage workspace plugins').click()
 manager();g.get_by_role('textbox',name='Plugin manifest JSON').fill(json.dumps(manifest));g.get_by_role('button',name='Install plugin manifest').click();expect(g.get_by_role('button',name='Enable plugin notes',exact=True)).to_be_visible();g.get_by_role('button',name='Enable plugin notes',exact=True).click();expect(g.get_by_role('button',name='Disable plugin notes',exact=True)).to_be_visible();g.get_by_role('button',name='Close workspace plugins').click()
 frame=g.frame_locator('iframe[src*="/apps/notes-"]');expect(frame.locator('h1')).to_have_text('Workspace notes',timeout=15000)
 def control(operation):subprocess.run(['python3',str(R/'scripts/workspace_control.py'),'--workspace',wid,'apply',json.dumps(operation)],check=True,capture_output=True)
 control({'action':'plugin_patch_config','plugin_id':'notes','patch':{'title':'Live configured'}})
 expect(frame.locator('h1')).to_have_text('Live configured',timeout=15000)
 control({'action':'plugin_patch_config','plugin_id':'notes','patch':{'message':'Controller verified'}})
 control({'action':'plugin_window','plugin_id':'notes','settings':{'name':'Customized notes','fontSize':12}})
 expect(frame.locator('h1')).to_have_text('Live configured',timeout=15000);expect(frame.locator('#message')).to_have_text('Controller verified')
 manager()
 g.once('dialog',lambda d:d.accept(json.dumps({'name':'Customized notes','fontSize':12})))
 with g.expect_response(lambda r:r.url.endswith('/api/workspace') and r.request.post_data_json.get('action')=='plugins_apply') as changed:g.get_by_role('button',name='Customize plugin window notes',exact=True).click()
 assert changed.value.status==200
 g.wait_for_timeout(1500)
 g.get_by_role('button',name='Disable plugin notes',exact=True).click();expect(g.get_by_role('button',name='Enable plugin notes',exact=True)).to_be_visible();g.get_by_role('button',name='Close workspace plugins').click();expect(g.locator('iframe[src*="/apps/notes-"]')).to_have_count(0,timeout=15000)
 g.evaluate('''async ({token,id})=>{const api=async body=>{const r=await fetch('/api/workspace',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:id,...body})});if(!r.ok)throw Error(await r.text());return r.json()};const h=await api({action:'history'});await api({action:'restore',checkpoint_id:h.checkpoints[0].id,base_revision:h.revision,confirm:true})}''',{'token':env['ORBIT_TOKEN'],'id':wid})
 expect(frame.locator('h1')).to_have_text('Live configured',timeout=15000);assert g.evaluate('window.pluginTestMarker')=='same-document'
 assert not errors,errors
 b.close();print('PASS: real plugin publish/install/enable/configure/disable/checkpoint restore, no page reload or JS errors.')
