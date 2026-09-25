from pathlib import Path
import json,subprocess
from playwright.sync_api import sync_playwright,expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu
R=Path(__file__).resolve().parents[1];env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1440,'height':900});g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(1800)
 wid=g.evaluate('localStorage.getItem("orbit.workspace.id")');g.evaluate('window.viewportMarker=42')
 def ctl(command,*args):return json.loads(subprocess.check_output(['python3',str(R/'scripts/workspace_control.py'),'--workspace',wid,command,*args],text=True))
 before=ctl('read');history=ctl('history');checkpoint=ctl('checkpoint','--label','Preview acceptance')['checkpoint']
 preview=ctl('preview',json.dumps({'action':'patch_appearance','patch':{'fullViewport':True}}),'--base-revision',str(before['revision']))
 assert preview['preview'];assert ctl('read')['revision']==before['revision'];assert len(ctl('history')['checkpoints'])==len(history['checkpoints'])+1
 for value in [True,False,True]:
  result=ctl('apply',json.dumps({'action':'patch_appearance','patch':{'fullViewport':value}}));assert result['browser_applied']
  open_menu(g);expect(g.get_by_role('button',name='Exit full viewport' if value else 'Full viewport',exact=True)).to_be_visible()
  if value:assert g.locator('.workspace').bounding_box()=={'x':0,'y':0,'width':1440,'height':900}
 assert g.evaluate('window.viewportMarker')==42
 result=ctl('apply',json.dumps({'action':'arrange_windows','width':1440,'height':900,'columns':2,'gap':8}));assert result['browser_applied'];assert result['state']['monitors'][0]['frame']['width']==716
 expect(g.locator('.desktop-window').first).to_have_css('width','716px')
 result=ctl('apply',json.dumps({'action':'reset_appearance','keys':['fullViewport']}));assert result['browser_applied'];open_menu(g);expect(g.get_by_role('button',name='Full viewport',exact=True)).to_be_visible()
 result=ctl('apply',json.dumps({'action':'patch_appearance','patch':{'fullViewport':False,'headerHeight':36,'sidebarWidth':240,'workspaceGap':4,'accentColor':'#abcdef','navigationPosition':'top','wallpaperFit':'contain'}}));assert result['browser_applied']
 expect(g.locator('.topbar')).to_have_css('height','36px');expect(g.locator('.inspector')).to_have_css('width','240px');expect(g.locator('.workspace')).to_have_css('background-size','contain');expect(g.locator('.scene-navigation')).to_have_css('top','40px')
 result=ctl('apply',json.dumps({'action':'patch_appearance','patch':{'fullViewport':True}}));assert result['browser_applied']
 g.get_by_role('button',name='Exit full viewport',exact=True).click();g.wait_for_timeout(2000);assert ctl('read')['state']['appearance']['fullViewport']==False
 restored=ctl('restore',checkpoint,'--base-revision',str(ctl('read')['revision']),'--confirm');assert restored['browser_applied'];assert restored['state']==before['state']
 b.close();print('PASS: preview leaves state/history/revision untouched; controller checkpoint restore acknowledged; live viewport and chrome controls verified.')
