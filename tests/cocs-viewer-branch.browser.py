from pathlib import Path
import json
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1600,'height':1000},accept_downloads=True);errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('https://kimi.tailec998.ts.net:10446/health')
 page.set_content('<iframe sandbox="allow-scripts allow-forms allow-modals allow-downloads" style="width:1550px;height:940px" src="https://kimi.tailec998.ts.net:10446/"></iframe>')
 workshop=page.frame_locator('iframe');shell=workshop.frame_locator('#view')
 shell.frame_locator('#active').locator('#status').filter(has_text='Vehicles / Puma').wait_for(timeout=90000)
 assert shell.locator('#branch').input_value()=='feat/fieldwork-plan'
 def inspect():
  f=shell.locator('#active').element_handle().content_frame();results={}
  for vehicle in ['puma','titan','scout','transport']:
   f.evaluate('(id)=>window.cocsViewer.select("vehicle:"+id)',vehicle)
   f.wait_for_function('window.cocsViewer.ready')
   results[vehicle]=f.evaluate('window.cocsViewer.inspect()')
   assert 'shared Puma chassis' not in f.locator('#description').inner_text()
  assert len({(v['meshes'],v['triangles']) for v in results.values()})==4,results
  return results
 print('PASS bundled distinct vehicle models',json.dumps(inspect()),flush=True)
 shell.locator('#update').click();shell.locator('#confirm').click()
 shell.locator('#update').wait_for(state='visible')
 page.wait_for_function('true')
 from playwright.sync_api import expect
 expect(shell.locator('#update')).to_be_enabled(timeout=240000)
 status=shell.locator('#message').inner_text();print(status,flush=True)
 assert status.startswith('Loaded GitHub feat/fieldwork-plan @'),status
 print('PASS updated distinct vehicle models',json.dumps(inspect()),flush=True)
 with page.expect_download() as dl:shell.locator('#download').click()
 target=R/'.runtime/cocs-branch-snapshot.html';dl.value.save_as(target)
 offline=b.new_page();offline.goto(target.as_uri());offline.wait_for_function('window.cocsViewer?.ready',timeout=90000);offline.close()
 print('PASS offline snapshot',flush=True)
 page.route('https://api.github.com/**',lambda route:route.abort())
 shell.locator('#update').click();shell.locator('#confirm').click()
 expect(shell.locator('#update')).to_be_enabled(timeout=30000)
 assert 'previous collection retained' in shell.locator('#message').inner_text()
 inspect();print('PASS failed fetch retains models',flush=True)
 shell.locator('#reset').click();shell.frame_locator('#active').locator('#status').filter(has_text='Vehicles / Puma').wait_for(timeout=90000)
 inspect();print('PASS reset retains new bundled vehicle pack',flush=True)
 assert not errors,errors
 page.screenshot(path=str(R/'.runtime/cocs-vehicle-branch.png'))
 print('PASS nested Workshop sandbox; no JavaScript exceptions',flush=True)
 b.close()
