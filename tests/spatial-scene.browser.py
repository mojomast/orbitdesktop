import json, os
from playwright.sync_api import sync_playwright, expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu
URL=os.environ.get('ORBIT_TEST_URL','http://127.0.0.1:4325/')
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
 g=b.new_page(viewport={'width':1600,'height':1100},device_scale_factor=2)
 errors=[];g.on('pageerror',lambda e:errors.append(str(e)))
 g.goto(URL,wait_until='networkidle')
 menu(g,'Switch to spatial view')
 expect(g.get_by_role('button',name='3D layout and window settings',exact=True)).to_be_visible()
 def state():
  g.wait_for_timeout(350)
  return g.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
 original=state(); ids=[m['layout']['pane']['id'] for m in original['monitors']]
 def settings():g.get_by_role('button',name='3D layout and window settings',exact=True).click()
 settings();g.get_by_role('button',name='Grid',exact=True).click()
 tiled=state();assert all('spatial' in m for m in tiled['monitors'])
 g.get_by_role('button',name='Curved wall',exact=True).click();assert state()['monitors'][0]['spatial']['yaw']!=0
 g.get_by_role('button',name='Single row',exact=True).click();assert len(set(m['spatial']['y'] for m in state()['monitors']))==1
 g.get_by_role('button',name='Undo arrangement',exact=True).click();assert state()['monitors'][0]['spatial']['yaw']!=0
 g.get_by_role('button',name='Grid',exact=True).click()
 g.get_by_label('3D surface resolution',exact=True).select_option('3840')
 g.get_by_label('Position Z / depth',exact=True).fill('1')
 g.get_by_role('button',name='Done',exact=True).click()
 selected=state()['selected'];window=g.locator(f'[data-monitor-id="{selected}"]')
 g.get_by_role('button',name='Approach selected 3D window',exact=True).click()
 assert float(g.locator(f'[data-anchor-id="{selected}"]').evaluate('e=>parseFloat(e.style.width)'))==3840
 before=state()
 def drag(locator,dx,dy,modifier=None):
  box=locator.bounding_box();assert box, 'missing drag target'
  x=box['x']+min(60,box['width']/3);y=box['y']+box['height']/2
  if modifier:g.keyboard.down(modifier)
  g.mouse.move(x,y);g.mouse.down();g.mouse.move(x+dx,y+dy,steps=12);g.mouse.up()
  if modifier:g.keyboard.up(modifier)
 def selected_spatial():return next(m['spatial'] for m in state()['monitors'] if m['id']==selected)
 s=selected_spatial();drag(window.locator('.monitor-bar strong'),100,50);after=selected_spatial();assert after['x']>s['x'] and after['y']<s['y'],(s,after)
 s=after;drag(window.locator('.monitor-bar strong'),0,60,'Shift');after=selected_spatial();assert after['z']<s['z'],(s,after)
 g.get_by_role('button',name='Approach selected 3D window',exact=True).click()
 s=selected_spatial();drag(window.locator('.window-resize'),70,30);after=selected_spatial();assert after['width']>s['width'] and after['height']>s['height'],(s,after)
 s=after;drag(window.locator('.monitor-bar strong'),50,20,'Control');after=selected_spatial();assert after['yaw']>s['yaw'] and after['pitch']>s['pitch'],(s,after)
 g.get_by_role('button',name='Toggle 3D navigation',exact=True).click()
 camera=state()['spatialCamera'];g.keyboard.down('w');g.wait_for_timeout(300);g.keyboard.up('w');after_camera=state()['spatialCamera'];assert after_camera!=camera
 stage=g.locator('.stage').bounding_box();x=stage['x']+stage['width']/2;y=stage['y']+stage['height']/2
 g.mouse.move(x,y);g.mouse.down();g.mouse.move(x+180,y+60,steps=15);g.mouse.up();assert state()['spatialCamera']['azimuth']!=after_camera['azimuth']
 cam=state()['spatialCamera'];g.keyboard.down('Shift');g.mouse.move(x,y);g.mouse.down();g.mouse.move(x+100,y+50,steps=10);g.mouse.up();g.keyboard.up('Shift');assert state()['spatialCamera']['x']!=cam['x']
 g.keyboard.press('Escape');expect(g.locator('.stage')).not_to_have_class(__import__('re').compile('spatial-navigating'))
 saved=state();assert [m['layout']['pane']['id'] for m in saved['monitors']]==ids
 g.reload(wait_until='networkidle');restored=state();assert restored['spatialCamera']==saved['spatialCamera'];assert [m['spatial'] for m in restored['monitors']]==[m['spatial'] for m in saved['monitors']]
 menu(g,'Switch to movable windows');expect(g.locator('.spatial-toolbar')).not_to_be_visible()
 menu(g,'Switch to spatial view');assert g.locator('.monitor-anchor .monitor').count()==len(ids)
 g.get_by_role('button',name='Frame all 3D windows',exact=True).click()
 g.screenshot(path='.runtime/spatial-scene-test.png')
 assert not errors,errors
 b.close()
 print('PASS: served production build; grid/row/curve/undo; 3840px surfaces; real pointer move/depth/independent resize/rotation; WASD/orbit/pan; reload persistence; 2D/3D switching; stable pane IDs; no JavaScript errors.')
