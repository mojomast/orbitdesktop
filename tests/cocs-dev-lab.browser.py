from pathlib import Path
import json
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox'])
 page=b.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 env=dict(l.split('=',1) for l in (R/'.env.deploy').read_text().splitlines() if '=' in l)
 origin=env['ORBIT_PUBLIC_ORIGIN'];page.goto(origin,wait_until='domcontentloaded')
 page.set_content('<iframe sandbox="allow-scripts allow-forms allow-modals allow-downloads" src="'+origin+'/apps/cocs-dev-lab-7c8d91bd4fad33e05c91a9eb/index.html"></iframe>')
 f=page.frame_locator('iframe');f.locator('#weapons tr').first.wait_for()
 assert f.locator('#weapons tr').count()==10
 assert f.locator('#weapons tr').first.locator('td').nth(6).inner_text()=='110'
 f.get_by_label('Pulse Rifle damage',exact=True).fill('22');f.get_by_label('Pulse Rifle damage',exact=True).press('Tab')
 assert f.locator('#weapons tr').first.locator('td').nth(6).inner_text()=='220'
 f.get_by_role('button',name='Change review',exact=True).click();assert '11 → 22' in f.locator('#diff').inner_text()
 with page.expect_download() as d:f.locator('#export').click()
 data=json.loads(Path(d.value.path()).read_text());assert data['changes'][0]['after']==22
 f.locator('#import').set_input_files({'name':'invalid.json','mimeType':'application/json','buffer':b'{"schema":"bad"}'})
 assert 'Import rejected' in f.locator('#message').inner_text()
 data['changes'][0]['after']=33
 f.locator('#import').set_input_files({'name':'valid.json','mimeType':'application/json','buffer':json.dumps(data).encode()})
 f.locator('#message').filter(has_text='Imported 1').wait_for();assert '11 → 33' in f.locator('#diff').inner_text()
 with page.expect_download() as d:f.locator('#brief').click()
 assert 'Do not push' in Path(d.value.path()).read_text()
 f.get_by_role('button',name='Loadout inspector',exact=True).click();f.locator('#character').select_option('claude')
 assert f.locator('#harnesses .good').count()==1
 assert f.locator('#harnesses .bad').count()==6
 f.get_by_role('button',name='Weapon balance',exact=True).click();f.locator('#distance').fill('1000')
 assert f.locator('#weapons tr').first.locator('td').nth(6).inner_text()=='0'
 with page.expect_download() as d:f.locator('#csv').click()
 assert len(Path(d.value.path()).read_text().splitlines())==11
 assert not errors,errors
 print('PASS: published opaque iframe; 10 real weapons; DPS editing; diff; JSON export/import and invalid rejection; brief download; Claude compatibility; out-of-range DPS; CSV; no JS errors')
 b.close()
