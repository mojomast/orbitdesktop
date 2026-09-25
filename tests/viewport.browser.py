from playwright.sync_api import sync_playwright,expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 for w,h in [(1440,900),(390,664),(900,450)]:
  g=b.new_page(viewport={'width':w,'height':h});errors=[];g.on('pageerror',lambda e:errors.append(str(e)))
  g.goto('https://kimi.tailec998.ts.net:4325/',wait_until='networkidle')
  menu(g,'Full viewport')
  box=g.locator('.workspace').bounding_box();assert box=={'x':0,'y':0,'width':w,'height':h},box
  assert g.evaluate('document.documentElement.scrollHeight <= innerHeight')
  g.reload(wait_until='networkidle');expect(g.get_by_role('button',name='Exit full viewport',exact=True)).to_be_visible()
  g.keyboard.press('Control+Alt+f');open_menu(g);expect(g.get_by_role('button',name='Full viewport',exact=True)).to_be_visible()
  assert not errors,errors
  g.close()
 b.close();print('PASS: full viewport exact bounds, no document overflow, persistence and keyboard exit at desktop, mobile and short landscape sizes')
