from pathlib import Path
import json
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
origin=env['ORBIT_PUBLIC_ORIGIN'].rstrip('/')
entry='/apps/workspace-workshop-8485a41db0d4c74792caca76/index.html'
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page();errors=[];g.on('pageerror',lambda e:errors.append(str(e)))
 g.route(origin+'/__workshop_test__',lambda r:r.fulfill(content_type='text/html',body='<body style="background:#183040"><iframe style="width:380px;height:900px;border:0;color-scheme:dark" sandbox="allow-scripts allow-forms allow-modals allow-downloads" src="'+entry+'"></iframe>'))
 g.goto(origin+'/__workshop_test__');f=g.frame_locator('iframe');expect(f.locator('h1')).to_have_text('Workspace Workshop')
 f.locator('#idea').fill('<b>Improve desktop</b>');f.get_by_role('button',name='Add',exact=True).click();expect(f.locator('article')).to_have_count(1);expect(f.locator('article b')).to_have_count(0)
 f.locator('select').select_option('In progress');f.locator('#checks input').nth(1).check();f.locator('#evidence').fill('Browser test evidence');f.locator('#fix').click();expect(f.locator('select')).to_have_value('Blocked')
 f.locator('#handoff').click();assert 'Browser test evidence' in f.locator('#message').input_value()
 with g.expect_download() as d:f.locator('#export').click()
 data=json.loads(Path(d.value.path()).read_text());assert data['tasks'][0]['checks'][1] is True
 g.reload();expect(f.locator('article')).to_have_count(0)
 f.locator('#file').set_input_files({'name':'board.json','mimeType':'application/json','buffer':json.dumps(data).encode()});expect(f.locator('article')).to_have_count(1);expect(f.locator('#evidence')).to_have_value('Browser test evidence')
 f.locator('#file').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{"version":1,"tasks":[{}]}'});expect(f.locator('#notice')).to_contain_text('Import failed');expect(f.locator('article')).to_have_count(1)
 assert not errors,errors
 print('PASS: published sandbox queue, status, verification, fixing flag, safe text rendering, message handoff, actual download, reload/import recovery, invalid import protection; no JS errors.')
 b.close()
