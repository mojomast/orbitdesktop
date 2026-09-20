from pathlib import Path
import subprocess,json
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (ROOT/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000})
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(2000)
 wid=g.evaluate('localStorage.getItem("orbit.workspace.id")');before=g.locator('.workspace').evaluate('(e)=>getComputedStyle(e).backgroundImage')
 subprocess.run(['python3',str(ROOT/'scripts/workspace_control.py'),'--workspace',wid,'apply',json.dumps({'action':'set_appearance','appearance':{'background':'#123456','wallpaper':''}})],check=True,capture_output=True)
 expect(g.locator('.workspace')).to_have_css('background-color','rgb(18, 52, 86)',timeout=15000);expect(g.locator('.workspace')).to_have_css('background-image','none')
 # Restore the automatic checkpoint using the authenticated API, not direct file editing.
 result=g.evaluate('''async ({token,id})=>{const request=async body=>{const r=await fetch('/api/workspace',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:id,...body})});if(!r.ok)throw Error(await r.text());return r.json()};const h=await request({action:'history'});return request({action:'restore',checkpoint_id:h.checkpoints[0].id,base_revision:h.revision,confirm:true})}''',{'token':env['ORBIT_TOKEN'],'id':wid})
 expect(g.locator('.workspace')).to_have_css('background-image',before,timeout=15000)
 g.reload(wait_until='networkidle');expect(g.locator('.workspace')).to_have_css('background-image',before)
 print('PASS: controller appearance update visible without reload; checkpoint restores prior wallpaper; restore survives reload.')
 b.close()
