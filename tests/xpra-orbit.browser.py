"""Verify Xpra in an actual Orbit browser pane, isolated test workspace."""
from pathlib import Path
import json
import subprocess
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 g=b.new_page(viewport={'width':1500,'height':1100})
 g.goto(env['ORBIT_PUBLIC_ORIGIN'])
 g.get_by_role('button',name='Connect local host',exact=True).click()
 g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN'])
 g.get_by_role('button',name='Unlock local host',exact=True).click()
 g.wait_for_timeout(1500)
 wid=g.evaluate('localStorage.getItem("orbit.workspace.id")')
 ops=[{'action':'set_view','view':'windows'},{'action':'add_window','name':'Xpra integration test','kind':'browser','url':'https://kimi.tailec998.ts.net:4348/','frame':{'x':10,'y':10,'width':1300,'height':950,'z':100}}]
 subprocess.run(['python3',str(R/'scripts/workspace_control.py'),'--workspace',wid,'apply',json.dumps(ops)],check=True,capture_output=True)
 f=g.frame_locator('iframe[src*="4348"]')
 f.locator('#password').fill((R/'.runtime/xpra/password').read_text())
 f.get_by_text('Connect',exact=True).click()
 expect(f.locator('canvas').first).to_be_visible(timeout=30000)
 g.screenshot(path=str(R/'.runtime/xpra/orbit-embedded.png'))
 b.close()
 print('PASS: real Orbit external-browser pane authenticates and displays Xpra application canvas over private HTTPS.')
