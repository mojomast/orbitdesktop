from pathlib import Path
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1];env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000});calls=[]
 job={'id':'test-only','name':'Test automation','prompt':'Synthetic task','schedule':'every 1h','deliver':'local','skills':[]}
 def route(r):
  data=r.request.post_data_json
  if data.get('action')=='jobs':r.fulfill(json={'jobs':[job]});return
  if data.get('action')=='automation':calls.append(data);r.fulfill(json={'job':job,'accepted':True});return
  r.continue_()
 g.route('**/api/agent',route);g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(1800)
 g.get_by_role('button',name='Focus Display 03',exact=True).click(force=True);g.get_by_role('button',name='Hermes tools and conversations').click();g.get_by_role('button',name='Open actual Hermes scheduled tasks').click()
 for opener,operation in [('New automation','create'),('Edit task Test automation','update'),('Duplicate task Test automation','create')]:
  g.get_by_role('button',name=opener,exact=True).click();g.get_by_role('textbox',name='Task name',exact=True).fill('Test automation');g.get_by_role('textbox',name='Schedule',exact=True).fill('every 1h');g.get_by_role('textbox',name='Task prompt',exact=True).fill('Synthetic task');g.once('dialog',lambda d:d.accept());g.get_by_role('button',name='Save automation',exact=True).click();expect(g.get_by_role('dialog',name='Automation editor',exact=True)).to_have_count(0);assert calls[-1]['operation']==operation and calls[-1]['confirm']
 for op in ['run','delete']:
  g.once('dialog',lambda d:d.accept());g.get_by_role('button',name=op+' task Test automation',exact=True).click();g.wait_for_timeout(200);assert calls[-1]['operation']==op
 b.close();print('PASS: create/edit/duplicate/run/delete browser flows using explicit fake API; real schedules untouched')
