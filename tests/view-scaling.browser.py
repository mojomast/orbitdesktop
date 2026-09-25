import os
from playwright.sync_api import sync_playwright, expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu
URL=os.environ.get('ORBIT_TEST_URL','http://127.0.0.1:4325/')
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
 g=b.new_page(viewport={'width':1600,'height':1100})
 errors=[];g.on('pageerror',lambda e:errors.append(str(e)))
 g.goto(URL,wait_until='networkidle')
 def state():
  g.wait_for_timeout(400)
  return g.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
 def selected():
  s=state();return next(m for m in s['monitors'] if m['id']==s['selected'])
 def slider(label,value):
  g.get_by_label(label,exact=True).fill(str(value));g.get_by_label(label,exact=True).dispatch_event('input');g.wait_for_timeout(200)
 def switch(name):menu(g,name)
 # Test normal legacy windows first, with independent initial sizes.
 original=selected()['fontSize']
 slider('Desktop text size',22)
 assert selected()['fontSize']==22 and selected()['spatialFontSize']==original
 switch('Switch to spatial view')
 expect(g.get_by_label('3D text size',exact=True)).to_have_value(str(original))
 slider('3D text size',60)
 assert selected()['spatialFontSize']==60 and selected()['fontSize']==22, selected()
 switch('Switch to movable windows')
 expect(g.get_by_label('Desktop text size',exact=True)).to_have_value('22')
 slider('Desktop text size',16)
 switch('Switch to spatial view')
 expect(g.get_by_label('3D text size',exact=True)).to_have_value('60')
 g.reload(wait_until='networkidle')
 assert selected()['spatialFontSize']==60 and selected()['fontSize']==16
 expect(g.get_by_label('3D text size',exact=True)).to_have_value('60')
 # All mode buttons must be unobstructed at their centers at multiple sizes.
 for width in [1600,1024,700,390]:
  g.set_viewport_size({'width':width,'height':900});g.wait_for_timeout(250)
  open_menu(g)
  for label in ['Switch to movable windows','Switch to spatial view','Focus selected display']:
   target=g.get_by_role('button',name=label,exact=True)
   assert target.evaluate('e=>{const r=e.getBoundingClientRect();return r.x>=0 && r.right<=innerWidth && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}'),(width,label)
  close_menu(g)
  switch('Switch to movable windows');switch('Switch to spatial view')
 g.set_viewport_size({'width':1600,'height':1100})
 g.screenshot(path='.runtime/view-scaling-test.png')
 assert not errors,errors
 b.close()
 print('PASS: independent desktop/3D sizes, legacy initialization, 60px 3D text, switching, reload persistence; view switcher unobstructed at 1600/1024/700/390px; no JS errors.')
