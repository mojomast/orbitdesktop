from pathlib import Path
import json,sys,time
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[2]
entry=sys.argv[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
results=[];errors=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1400,'height':950},device_scale_factor=1)
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(env['ORBIT_PUBLIC_ORIGIN']+entry,wait_until='networkidle')
 page.wait_for_function('window.cocsViewer?.ready',timeout=90000)
 print('START',page.evaluate('({catalog:window.cocsViewer.catalog.length,state:window.cocsViewer.inspect()})'),flush=True)
 page.screenshot(path=str(R/'apps/cocs-viewer/vehicle-preview.png'))
 for asset in page.evaluate('window.cocsViewer.catalog'):
  start=time.time()
  page.evaluate('(id)=>window.cocsViewer.select(id)',asset['id'])
  page.wait_for_function('window.cocsViewer.ready',timeout=60000)
  frame=page.evaluate('window.cocsViewer.frames')
  page.wait_for_function('(n)=>window.cocsViewer.frames>n',arg=frame)
  data=page.evaluate('window.cocsViewer.inspect()')
  assert data['meshes']>0 and data['triangles']>0,data
  results.append({'id':asset['id'],'meshes':data['meshes'],'triangles':data['triangles'],'seconds':round(time.time()-start,2)})
  if asset['id'] in ['map:blood-gulch','map:moth-backrooms','character:chatgpt','weapon:0']:
   page.wait_for_timeout(250)
   page.screenshot(path=str(R/('apps/cocs-viewer/'+asset['id'].replace(':','-')+'.png')))
  print('PASS',asset['id'],data['meshes'],flush=True)
 page.locator('#search').fill('blood')
 assert page.locator('#list button').count()==1
 page.locator('#list button').click();page.wait_for_function('window.cocsViewer.ready && window.cocsViewer.selected==="map:blood-gulch"')
 before=page.evaluate('window.cocsViewer.inspect().camera')
 page.locator('#top').click()
 assert before!=page.evaluate('window.cocsViewer.inspect().camera')
 page.locator('#wire').check();assert page.evaluate('window.cocsViewer.inspect().wireframe')
 page.locator('#wire').uncheck()
 before=page.evaluate('window.cocsViewer.inspect().camera')
 page.locator('#viewport').focus();page.keyboard.down('w');page.wait_for_timeout(350);page.keyboard.up('w')
 assert before!=page.evaluate('window.cocsViewer.inspect().camera')
 page.locator('#detailsToggle').click();assert page.locator('#metadata').is_visible()
 page.locator('#sidebar').click();assert not page.locator('#library').is_visible()
 page.set_viewport_size({'width':700,'height':550});page.wait_for_timeout(300)
 assert page.evaluate('window.cocsViewer.inspect().canvas[0]')<1000
 errors+=page.evaluate('window.cocsViewer.errors')
 assert not errors,errors
 embed=b.new_page(viewport={'width':1200,'height':850})
 embed.on('pageerror',lambda e:errors.append(str(e)))
 embed.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='domcontentloaded')
 embed.set_content('<iframe title="Viewer" sandbox="allow-scripts allow-forms allow-modals allow-downloads" style="width:1150px;height:800px;border:0" src="'+env['ORBIT_PUBLIC_ORIGIN']+entry+'"></iframe>')
 frame=embed.frame_locator('iframe')
 frame.locator('#status').filter(has_text='Vehicles / Puma').wait_for(timeout=60000)
 frame.locator('#search').fill('moth-backrooms')
 frame.locator('#list button').click()
 frame.locator('#status').filter(has_text='Maps /').wait_for(timeout=60000)
 frame.locator('#wire').check()
 embed.screenshot(path=str(R/'apps/cocs-viewer/embedded-preview.png'))
 assert not errors,errors
 (R/'apps/cocs-viewer/test-results.json').write_text(json.dumps({'assets':results,'errors':errors,'ui':'search, selection, top view, wireframe, keyboard navigation, details, sidebar, resize passed'},indent=2))
 b.close()
 print('PASS ALL',len(results),'assets; UI controls; no JS errors',flush=True)
