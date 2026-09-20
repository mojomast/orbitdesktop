"""Opt-in spatial manipulation and preview live-update acceptance test."""
from pathlib import Path
import json
import subprocess
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (ROOT/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page(viewport={'width':1800,'height':1100});errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 page.get_by_role('button',name='Switch to spatial view',exact=True).click()
 window=page.locator('.monitor').nth(1); bar=window.locator('.monitor-bar'); handle=window.locator('.window-resize')
 expect(handle).to_be_visible()
 before=window.bounding_box(); r=bar.bounding_box()
 page.mouse.move(r['x']+r['width']*.22,r['y']+r['height']*.5);page.mouse.down();page.mouse.move(r['x']+r['width']*.22+60,r['y']+r['height']*.5-40,steps=10);page.mouse.up()
 page.wait_for_timeout(400);after=window.bounding_box();assert after['x']>before['x']+20,(before,after)
 r=handle.bounding_box();page.mouse.move(r['x']+r['width']/2,r['y']+r['height']/2);page.mouse.down();page.mouse.move(r['x']+r['width']/2+45,r['y']+r['height']/2+30,steps=10);page.mouse.up()
 page.wait_for_timeout(400);state=json.loads(page.evaluate("localStorage.getItem('orbit.workspace.v1')"));assert state['monitors'][1]['diagonal']>32,state['monitors'][1]
 print('3D pointer dragging and resizing: passed',flush=True)
 page.get_by_role('button',name='Connect local host',exact=True).click();page.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);page.get_by_role('button',name='Unlock local host',exact=True).click()
 page.wait_for_timeout(1800);wid=page.evaluate("localStorage.getItem('orbit.workspace.id')")
 app=ROOT/'.runtime/apps/spatial-live-test';app.mkdir(exist_ok=True);file=app/'index.html';file.write_text('<h1>Before edit</h1>')
 cmd=['python3',str(ROOT/'scripts/workspace_control.py'),'--workspace',wid,'apply']
 subprocess.run(cmd+[json.dumps({'action':'add_window','name':'Live Preview','kind':'browser','url':'/apps/spatial-live-test/'})],check=True,capture_output=True)
 frame=page.frame_locator('iframe[src*="/apps/spatial-live-test/"]');expect(frame.locator('h1')).to_have_text('Before edit',timeout=15000)
 page.wait_for_timeout(1500);page.evaluate('window.liveTestMarker = 42');file.write_text('<h1>After edit</h1>')
 expect(frame.locator('h1')).to_have_text('After edit',timeout=10000)
 assert page.evaluate('window.liveTestMarker')==42
 assert not errors,errors
 print('Agent layout update and edited preview appear without workspace refresh: passed',flush=True)
 b.close()
