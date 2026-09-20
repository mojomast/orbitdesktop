from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (ROOT/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000});errors=[]
 g.on('pageerror',lambda e:errors.append(str(e)))
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click()
 g.wait_for_timeout(1800);g.get_by_role('button',name='Focus Display 03',exact=True).click(force=True)
 g.get_by_role('button',name='Hermes tools and conversations').click();g.get_by_role('button',name='Open workspace checkpoints').click()
 g.get_by_role('button',name='Save workspace checkpoint',exact=True).click()
 restore=g.get_by_role('button',name='Restore checkpoint ',exact=False);expect(restore.first).to_be_visible()
 g.on('dialog',lambda dialog:dialog.accept())
 with g.expect_response(lambda r:r.url.endswith('/api/workspace') and r.request.post_data_json.get('action')=='restore') as response:restore.first.click()
 assert response.value.status==200,response.value.text()
 expect(g.get_by_role('dialog',name='Workspace checkpoints')).to_contain_text('Before restore')
 g.get_by_role('button',name='Close workspace checkpoints').click()
 assert not errors,errors
 print('PASS: live save, confirmed restore, before-restore checkpoint, no JavaScript errors; isolated browser workspace only.')
 b.close()
