from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright,expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu
R=Path(__file__).resolve().parents[1];env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1100})
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle');g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(1800)
 g.get_by_role('button',name='Focus Display 03',exact=True).click(force=True);g.get_by_role('button',name='Hermes tools and conversations').evaluate('(e)=>e.click()');g.get_by_role('button',name='Open shared Chromium',exact=True).click()
 menu(g,'Switch to movable windows')
 assert g.locator('dialog[open]').count()==0
 frame=g.locator('iframe[title="Shared Chromium desktop"]');expect(frame).to_have_count(1)
 win=frame.locator('xpath=ancestor::*[@data-monitor-id][1]');before=win.bounding_box()
 bar=g.get_by_label('Move Shared Chromium',exact=True);box=bar.bounding_box();g.mouse.move(box['x']+180,box['y']+12);g.mouse.down();g.mouse.move(box['x']+260,box['y']+52,steps=8);g.mouse.up();after=win.bounding_box();assert after['x']>before['x']+50
 g.get_by_role('button',name='Resize Shared Chromium',exact=True).focus();g.keyboard.press('ArrowRight');assert win.bounding_box()['width']>after['width']
 f=g.frame_locator('iframe[title="Shared Chromium desktop"]');f.locator('#noVNC_password_input').fill((R/'.runtime/shared-browser/password.txt').read_text());f.locator('#noVNC_credentials_button').click();expect(f.locator('#noVNC_container canvas')).to_be_visible(timeout=20000)
 subprocess.run([str(R/'.runtime/browser-venv/bin/python'),str(R/'scripts/shared_browser.py'),'navigate','--url','https://example.com'],check=True)
 # Focus a harmless test field through CDP, then type through the actual VNC canvas.
 remote=p.chromium.connect_over_cdp('http://127.0.0.1:4345');page=remote.contexts[0].pages[0]
 page.set_content('<h1>Shared browser acceptance</h1><input autofocus style="position:fixed;left:0;top:0;width:100vw;height:80vh;font-size:30px" aria-label="Shared test input">')
 page.locator('input').focus();g.wait_for_timeout(800)
 canvas=f.locator('#noVNC_container canvas');cb=canvas.bounding_box();canvas.click(position={'x':cb['width']*.4,'y':cb['height']*.4});g.keyboard.type('HUMAN_SHARED_INPUT',delay=60);g.wait_for_timeout(1000)
 assert page.locator('input').input_value()=='HUMAN_SHARED_INPUT',page.locator('input').input_value()
 win.locator('.window-minimize').click();expect(frame).not_to_be_visible();assert page.locator('input').input_value()=='HUMAN_SHARED_INPUT'
 g.evaluate("window.dispatchEvent(new Event('orbit-open-shared-browser'))");expect(frame).to_be_visible();expect(frame).to_have_count(1)
 g.reload(wait_until='networkidle');expect(g.locator('iframe[title="Shared Chromium desktop"]')).to_have_count(1)
 page.goto('https://example.com',wait_until='domcontentloaded')
 b.close();print('PASS: authenticated Orbit viewer, real VNC canvas, agent navigation, human keyboard navigation observed by agent, browser survives viewer close.')
