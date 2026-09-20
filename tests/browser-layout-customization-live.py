from pathlib import Path
import json,subprocess
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1];env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000});g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(1800)
 wid=g.evaluate('localStorage.getItem("orbit.workspace.id")');g.evaluate('window.layoutCheck="retained"')
 def ctl(command,*args):return json.loads(subprocess.check_output(['python3',str(R/'scripts/workspace_control.py'),'--workspace',wid,command,*args],text=True))
 s=ctl('read')['state'];m=s['monitors'][0];pid=m['layout']['pane']['id']
 ctl('apply',json.dumps({'action':'split_pane','window_id':m['id'],'pane_id':pid,'kind':'browser'}))
 result=ctl('apply',json.dumps([{'action':'update_split','window_id':m['id'],'path':[],'ratio':0.7,'axis':'column','swap':True},{'action':'patch_appearance','patch':{'background':'#123456','wallpaper':''}}]))
 assert result['browser_applied'];assert result['state']['monitors'][0]['layout']['second']['pane']['id']==pid
 expect(g.locator('.workspace')).to_have_css('background-color','rgb(18, 52, 86)',timeout=15000)
 assert g.evaluate('window.layoutCheck')=='retained'
 print('PASS: live controller split modification acknowledged, original pane ID preserved, partial appearance applied without page reload.')
 b.close()
