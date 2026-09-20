from pathlib import Path
import json
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1];env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000});g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(1800)
 g.get_by_role('button',name='Focus Display 03',exact=True).click(force=True);g.get_by_role('button',name='Hermes tools and conversations').click();g.get_by_role('button',name='Open Jev quick actions').click()
 g.get_by_role('textbox',name='TypeSafe API key').fill('synthetic-test-key');g.get_by_role('textbox',name='Jev workspace request').fill('Switch to 3D');g.get_by_role('button',name='Preview Jev quick action').click();expect(g.get_by_role('dialog',name='Jev quick actions')).to_contain_text('consent required');expect(g.get_by_role('button',name='Apply Jev preview')).to_be_disabled()
 # Explicit fixture for provider decision only; apply uses real authenticated workspace backend.
 def route(r):
  body=r.request.post_data_json
  if body.get('action')!='jev_suggest':r.continue_();return
  response=g.request.post(env['ORBIT_PUBLIC_ORIGIN']+'/api/workspace',headers={'Authorization':'Bearer '+env['ORBIT_TOKEN'],'Origin':env['ORBIT_PUBLIC_ORIGIN']},data={'action':'read','workspace_id':body['workspace_id']});assert response.ok
  r.fulfill(json={'accepted':True,'action_id':'spatial','description':'Switch to spatial 3D view','base_revision':response.json()['revision'],'latency_ms':0,'confidence':1})
 g.route('**/api/workspace',route);g.get_by_role('checkbox').check();g.get_by_role('button',name='Preview Jev quick action').click();expect(g.get_by_role('button',name='Apply Jev preview')).to_be_enabled();g.once('dialog',lambda d:d.accept());g.get_by_role('button',name='Apply Jev preview').click();expect(g.get_by_role('dialog',name='Jev quick actions')).to_contain_text('Saved; workspace will synchronize.')
 g.get_by_role('button',name='Close Jev quick actions').click();expect(g.get_by_role('textbox',name='TypeSafe API key')).to_have_count(0)
 b.close();print('PASS: live UI consent gate, synthetic preview, real confirmed checkpointed apply, key field removed on close. No live TypeSafe inference performed.')
