import os
from playwright.sync_api import sync_playwright, expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
 g=b.new_page(viewport={'width':1600,'height':1100});errors=[]
 g.on('pageerror',lambda e:errors.append(str(e)))
 g.goto(os.environ.get('ORBIT_TEST_URL','http://127.0.0.1:4397/'),wait_until='networkidle')
 if g.get_by_role('button',name='Skip tour',exact=True).is_visible():g.get_by_role('button',name='Skip tour',exact=True).click()
 def click(label):g.get_by_role('button',name=label,exact=True).click()
 def state():
  g.wait_for_timeout(350);return g.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
 def presets():return g.evaluate('JSON.parse(localStorage.getItem("orbit.layouts."+localStorage.getItem("orbit.workspace.id")))')
 def open_layouts():click('Choose workspace layout')
 def slider(label,value):
  g.get_by_label(label,exact=True).fill(str(value));g.get_by_label(label,exact=True).dispatch_event('input');g.wait_for_timeout(350)
 original=state();ids=[m['id'] for m in original['monitors']]
 g.evaluate('window.originalMonitors=[...document.querySelectorAll(".monitor")];')
 open_layouts();g.get_by_label('Layout name',exact=True).fill('Desk');click('Rename current layout');click('Close workspace layouts')
 slider('Desktop text size',22)
 open_layouts();g.get_by_label('Layout name',exact=True).fill('Studio');click('Create layout from current');click('Close workspace layouts')
 menu(g,'Switch to spatial view');slider('3D text size',60)
 spatial=state();assert spatial['view']=='spatial'
 open_layouts();click('Switch layout Desk')
 desk=state();assert desk['view']=='windows'
 expect(g.get_by_label('Desktop text size',exact=True)).to_have_value('22')
 open_layouts();click('Switch layout Studio')
 expect(g.get_by_label('3D text size',exact=True)).to_have_value('60')
 assert [m['id'] for m in state()['monitors']]==ids
 assert g.evaluate('window.originalMonitors.every(e=>e.isConnected)')
 g.reload(wait_until='networkidle');assert state()['view']=='spatial'
 open_layouts();expect(g.get_by_role('button',name='Switch layout Desk',exact=True)).to_be_visible();click('Switch layout Desk')
 # Minimize windows into the same bar, not a second floating tray.
 selected=state()['selected'];name=next(m['name'] for m in state()['monitors'] if m['id']==selected)
 g.locator(f'[data-monitor-id="{selected}"] .window-minimize').click()
 expect(g.locator('.minimized-tray')).not_to_be_visible()
 expect(g.locator('.scene-navigation').get_by_role('button',name='Restore '+name,exact=True)).to_be_visible()
 click('Restore '+name)
 # Start keyboard search and launcher appearance.
 click('Open Start');g.get_by_label('Search Start').fill('Spatial view');g.get_by_label('Search Start').press('Enter')
 assert state()['view']=='spatial'
 # Rename/delete (confirmation) and persistence.
 open_layouts();g.get_by_label('Layout name',exact=True).fill('Renamed');click('Rename current layout')
 g.on('dialog',lambda d:d.accept());click('Delete current layout');click('Close workspace layouts')
 assert len(presets()['layouts'])==1
 for width in [1600,1024,700,390]:
  g.set_viewport_size({'width':width,'height':900});g.wait_for_timeout(200)
  open_menu(g)
  for label in ['Open Start','Choose workspace layout','Switch to movable windows','Switch to spatial view']:
   target=g.get_by_role('button',name=label,exact=True)
   assert target.evaluate('e=>{const r=e.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}'),(width,label)
  close_menu(g);open_layouts();expect(g.get_by_label('Layout name',exact=True)).to_be_visible();click('Close workspace layouts')
 g.set_viewport_size({'width':1600,'height':1100});open_layouts();g.screenshot(path='.runtime/unified-taskbar-test.png')
 assert not errors,errors
 b.close()
 print('PASS: unified minimize/restore taskbar, Start keyboard search, named 2D/3D switching, independent scaling, stable window nodes/IDs, reload, rename/delete, responsive hit tests (390–1600px), no JS errors.')
