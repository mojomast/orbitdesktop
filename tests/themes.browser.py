from pathlib import Path
from playwright.sync_api import sync_playwright,expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 page=b.new_page(viewport={'width':1440,'height':900});errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('https://kimi.tailec998.ts.net:4325/',wait_until='networkidle')
 page.keyboard.press('Escape')
 menu(page,'Choose workspace theme')
 page.get_by_role('button',name='Apply Ocean theme',exact=True).click()
 expect(page.get_by_role('dialog',name='Workspace themes').get_by_role('status')).to_contain_text('Connect host')
 page.get_by_role('button',name='Close workspace themes').click()
 page.get_by_role('button',name='Connect local host',exact=True).click()
 page.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN'])
 page.get_by_role('button',name='Unlock local host',exact=True).click()
 page.wait_for_timeout(1800)
 before=page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
 menu(page,'Choose workspace theme')
 page.get_by_role('button',name='Apply Ocean theme',exact=True).click()
 expect(page.get_by_role('dialog',name='Workspace themes').get_by_role('status')).to_contain_text('Ocean applied locally')
 expect(page.locator('.workspace')).to_have_css('background-color','rgb(9, 37, 53)')
 page.wait_for_timeout(1800)
 after=page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
 assert before['monitors']==after['monitors']
 assert after['appearance']['accentColor']=='#63d8ef'
 page.reload(wait_until='networkidle')
 expect(page.locator('.workspace')).to_have_css('background-color','rgb(9, 37, 53)')
 for name,theme in [('Windows XP','xp'),('Classic 95','classic'),('Paper Studio','paper'),('Cyberpunk','cyberpunk')]:
  page.get_by_role('button',name='Connect local host',exact=True).click()
  page.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN'])
  page.get_by_role('button',name='Unlock local host',exact=True).click()
  page.wait_for_timeout(1200)
  menu(page,'Choose workspace theme')
  page.get_by_role('button',name='Apply '+name+' theme',exact=True).click()
  expect(page.locator('html')).to_have_attribute('data-orbit-theme',theme)
  page.get_by_role('button',name='Close workspace themes').click()
  page.wait_for_timeout(1600)
  page.reload(wait_until='networkidle')
  expect(page.locator('html')).to_have_attribute('data-orbit-theme',theme)
 assert not errors,errors
 b.close()
 print('PASS: served theme picker, locked-host guard, authenticated checkpoint/apply, rendered Ocean color, unchanged panes and reload persistence in isolated browser workspace; no JS errors')
