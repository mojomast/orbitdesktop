from pathlib import Path
import json,time,subprocess
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1];env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000});out=[];ids=[]
 def socket(ws):
  ws.on('framereceived',lambda s:out.append(s))
  def sent(s):
   try:
    v=json.loads(s)
    if v.get('type')=='auth':ids.append(v['pane_id'])
   except:pass
  ws.on('framesent',sent)
 g.on('websocket',socket)
 def connect():
  g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(1800)
  g.get_by_role('button',name='Focus Display 01',exact=True).click(force=True);g.get_by_role('button',name='Connect to local host shell',exact=True).click();expect(g.locator('.connection-state')).to_contain_text('LIVE SHELL');g.wait_for_timeout(800)
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle');connect();g.locator('.xterm-helper-textarea').focus();g.keyboard.type("export ORBIT_RELOAD_VALUE=survived; printf 'READY_%s\\n' reload");g.keyboard.press('Enter');g.wait_for_timeout(500)
 g.reload(wait_until='networkidle');connect();out.clear();g.locator('.xterm-helper-textarea').focus();g.keyboard.type("printf 'VALUE_%s\\n' \"$ORBIT_RELOAD_VALUE\"");g.keyboard.press('Enter');g.wait_for_timeout(1000)
 assert 'VALUE_survived' in ''.join(out);assert ids[-1]==ids[0]
 b.close()
 subprocess.run(['systemd-run','--user','--wait','--pipe','/usr/bin/tmux','-L','orbit-persistent','kill-session','-t','pane-'+ids[0]],check=True)
 print('PASS: actual terminal UI retained shell variable across page reload and authenticated reconnect; same pane identity.')
