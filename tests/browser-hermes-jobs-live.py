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
 g.get_by_role('button',name='Hermes tools and conversations').click()
 with g.expect_response(lambda r:r.url.endswith('/api/agent') and r.request.post_data_json.get('action')=='jobs') as response:
  g.get_by_role('button',name='Open actual Hermes scheduled tasks').click()
 data=response.value.json();assert response.value.status==200,data
 jobs=data['jobs'];assert len(jobs)>0
 expect(g.locator('.hermes-job')).to_have_count(len(jobs));assert all('prompt' not in j and 'deliver' not in j for j in jobs)
 g.get_by_role('textbox',name='Filter Hermes tasks').fill(jobs[0]['id']);expect(g.locator('.hermes-job')).to_have_count(1)
 g.get_by_role('textbox',name='Filter Hermes tasks').fill('impossible-no-task-match');expect(g.locator('.hermes-job-list')).to_contain_text('No matching tasks')
 g.get_by_role('button',name='Refresh scheduled tasks',exact=True).click()
 g.get_by_role('button',name='Close scheduled tasks').click();expect(g.get_by_role('dialog',name='Hermes scheduled tasks')).to_have_count(0)
 assert not errors,errors
 print(f'PASS: {len(jobs)} real Hermes scheduled tasks displayed; filtering, refresh, close, private-field filtering and JavaScript checks passed.')
 b.close()
