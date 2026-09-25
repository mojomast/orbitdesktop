from pathlib import Path
import json,time
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 g=b.new_page(viewport={'width':1600,'height':1000});errors=[];g.on('pageerror',lambda e:errors.append(str(e)))
 acknowledgements=[]
 def observed(response):
  if response.url.endswith('/api/workspace') and response.ok:
   acknowledgements.append(response.json().get('observed_revision',0))
 g.on('response',observed)
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 seed=g.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
 next(m for m in seed['monitors'] if m['layout']['pane']['kind']=='browser')['layout']['pane']['url']='/apps/guy-3d/'
 seed['view']='spatial'
 g.add_init_script('if(window===window.top)localStorage.setItem("orbit.workspace.v1",'+json.dumps(json.dumps(seed))+');')
 g.reload(wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(1800)
 wid=g.evaluate('localStorage.getItem("orbit.workspace.id")')
 assert wid!='eed047a8-e519-495e-a7ca-1c8c150a6ef4'
 headers={'Authorization':'Bearer '+env['ORBIT_TOKEN'],'Origin':env['ORBIT_PUBLIC_ORIGIN']}
 def request(body):
  response=g.request.post(env['ORBIT_PUBLIC_ORIGIN']+'/api/workspace',headers=headers,data={**body,'workspace_id':wid})
  assert response.ok, response.status
  return response.json()
 g.get_by_role('button',name='3D layout and window settings',exact=True).click();g.get_by_role('button',name='Grid',exact=True).click();g.get_by_role('button',name='Done',exact=True).click()
 for _ in range(30):
  record=request({'action':'read'})
  if all('spatial' in m for m in record['state']['monitors']):break
  g.wait_for_timeout(200)
 else:raise AssertionError('Spatial fields did not sync')
 g.evaluate('''()=>{window.testMonitor=document.querySelector('.monitor');window.testFrame=document.querySelector('iframe');window.testLoads=0;window.testFrame.addEventListener('load',()=>window.testLoads++);}''')
 changed=record['state'];target=changed['monitors'][0];target['spatial']['x']=12;target['spatial']['resolution']=2560
 changed['spatialCamera']['x']=4
 reply=request({'action':'sync','base_revision':record['revision'],'state':changed})
 for _ in range(30):
  if g.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors[0].spatial.x')==12:break
  g.wait_for_timeout(200)
 else:raise AssertionError('Live remote spatial update did not arrive')
 g.wait_for_timeout(1500)
 assert g.evaluate('window.testMonitor===document.querySelector(".monitor") && window.testFrame===document.querySelector("iframe") && window.testLoads===0')
 assert g.locator('[data-anchor-id="'+target['id']+'"]').evaluate('e=>parseFloat(e.style.width)')==2560
 current=request({'action':'read'});assert current['state']['spatialCamera']['x']==4
 assert max(acknowledgements)>=reply['revision']
 assert not errors,errors
 b.close()
 print('PASS: isolated authenticated workspace; real server saves spatial geometry and camera; live polling applies geometry and 2560px resolution without page reload, DOM replacement or iframe reload; observed_revision acknowledged.')
