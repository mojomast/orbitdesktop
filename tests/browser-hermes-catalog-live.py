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
 with g.expect_response(lambda r:r.url.endswith('/api/agent') and r.request.post_data_json.get('action')=='catalog') as response:g.get_by_role('button',name='Browse actual Hermes capabilities').click()
 data=response.value.json();assert response.value.status==200,data;skills=len(data['items']);assert skills>0
 expect(g.locator('.hermes-catalog-list details')).to_have_count(skills)
 g.get_by_role('textbox',name='Search Hermes catalog').fill('impossible-no-entry');expect(g.locator('.hermes-catalog-list')).to_have_text('No matching entries.')
 g.get_by_role('textbox',name='Search Hermes catalog').fill('')
 with g.expect_response(lambda r:r.url.endswith('/api/agent') and r.request.post_data_json.get('kind')=='toolsets') as response:g.get_by_role('button',name='Browse Hermes toolsets').click()
 data=response.value.json();assert response.value.status==200,data;tools=len(data['items']);assert tools>0
 expect(g.locator('.hermes-catalog-list details')).to_have_count(tools);g.locator('.hermes-catalog-list summary').first.click();expect(g.locator('.hermes-catalog-list details').first).to_contain_text('Configured:')
 g.get_by_role('button',name='Close Hermes catalog').click();assert not errors,errors
 print(f'PASS: {skills} real skills and {tools} real toolsets; search, state display, close, no JavaScript errors.')
 b.close()
