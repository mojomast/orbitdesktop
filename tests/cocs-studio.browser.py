import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
O='https://kimi.tailec998.ts.net:4325'
ENTRY=sys.argv[1] if len(sys.argv)>1 else '/apps/cocs-studio-9d2eb12ede3f3f8d26e09a35/index.html'
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1600,'height':1050}); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(O,wait_until='domcontentloaded');page.set_content(f'<iframe style="width:1550px;height:1000px" sandbox="allow-scripts allow-forms allow-modals allow-downloads" src="{O+ENTRY}"></iframe>')
 s=page.frame_locator('iframe');s.locator('[data-tool=compare]').click()
 s.locator('#before').fill('{"a":1,"gone":true,"a/b":0}')
 s.locator('#after').fill('{"a":2,"new":null,"a/b":1}')
 s.locator('#diff').click();result=json.loads(s.locator('#diffResult').inner_text());assert len(result['changes'])==4;assert any(c['path']=='/a~1b' for c in result['changes'])
 with page.expect_download() as dl:s.locator('#diffExport').click()
 assert json.loads(Path(dl.value.path()).read_text())==result
 s.locator('#after').fill('{');assert s.locator('#diffExport').is_disabled();s.locator('#diff').click();assert 'Invalid JSON' in s.locator('#diffResult').inner_text()
 s.locator('[data-tool=planner]').click();s.locator('#title').fill('Shield test');s.locator('#behavior').fill('Tint on pickup; restore on expiry');s.locator('#recipe').fill('{"tint":"blue"}');s.locator('#checks input').first.check();s.locator('#brief').click();assert 'flashUntil' in s.locator('#briefResult').inner_text()
 with page.expect_download() as dl:s.locator('#projectExport').click()
 project=Path(dl.value.path()).read_bytes();s.locator('#title').fill('changed');assert s.locator('#briefExport').is_disabled()
 s.locator('#projectImport').set_input_files({'name':'project.json','mimeType':'application/json','buffer':project});expect(s.locator('#title')).to_have_value('Shield test')
 s.locator('#projectImport').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{}'});assert 'Import rejected' in s.locator('#briefResult').inner_text();expect(s.locator('#title')).to_have_value('Shield test')
 for tool,selector in [('assets','#revalidate'),('graphics','canvas'),('lattice','#graph circle'),('balance','#weapons tr')]:
  s.locator('nav [data-tool='+tool+']').click();f=s.frame_locator('iframe[data-tool='+tool+']');f.locator(selector).first.wait_for(timeout=90000);print('PASS embedded',tool)
 s.locator('nav [data-tool=lattice]').click();lf=s.frame_locator('iframe[data-tool=lattice]');lf.locator('#captureScenario').click()
 s.locator('nav [data-tool=planner]').click();expect(s.locator('#title')).to_have_value('Shield test');s.locator('nav [data-tool=lattice]').click();assert s.locator('iframe').count()==4
 page.screenshot(path=str(R/'.runtime/cocs-studio.png'))
 assert not errors,errors
 print('PASS published opaque sandbox: four live tools, diff export, malformed JSON, brief generation, project roundtrip, invalid import, retained tabs; no JS errors')
 b.close()
