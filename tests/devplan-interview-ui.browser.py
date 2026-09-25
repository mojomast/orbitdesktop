"""UI fixture tests are explicitly synthetic; live provider failure checked separately."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1];c=json.loads((R/'.runtime/devplan-interview/config.json').read_text())
env=dict(l.split('=',1) for l in (R/'.env.deploy').read_text().splitlines() if '=' in l)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(c['public_origin']);page.get_by_label('Orbit host token').fill(env['ORBIT_TOKEN'].strip().strip('"'));page.get_by_role('button',name='Unlock interview',exact=True).click();expect(page.get_by_role('button',name='Send answer',exact=True)).to_be_enabled(timeout=30000)
 page.locator('#chat-message').fill('Synthetic test: a seed inventory app.');page.get_by_role('button',name='Send answer',exact=True).click()
 expect(page.locator('#notice')).to_contain_text('authentication expired',timeout=90000)
 assert page.evaluate('Object.keys(state.answers).length')==0
 # Explicit synthetic proposal exercises UI only, not claimed model output.
 page.evaluate("proposal={name:'Fixture SeedShelf',goal:'Track seeds'};baseline=JSON.stringify(state.answers);render()")
 page.get_by_role('button',name='Accept proposed updates',exact=True).click();assert page.evaluate('state.answers.name')=='Fixture SeedShelf'
 page.evaluate("state.interview.push({role:'assistant',content:'Synthetic fixture follow-up'});persist();render()")
 with page.expect_download() as d:page.locator('#save').click()
 target=R/'.runtime/devplan-interview/ui-fixture.json';d.value.save_as(target)
 page.on('dialog',lambda d:d.accept());page.locator('#import').set_input_files(target)
 expect(page.locator('#notice')).to_contain_text('Project imported')
 assert page.evaluate('state.interview.length')==2
 page.set_viewport_size({'width':390,'height':844});assert page.locator('body').evaluate('e=>e.scrollWidth<=window.innerWidth')
 page.goto(c['orbit_origin']);page.set_content(f'<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups" src="{c["public_origin"]}"></iframe>');expect(page.frame_locator('iframe').get_by_role('heading',name='Talk through your project')).to_be_visible()
 assert not errors,errors
 print('PASS: real unlock, real model-auth failure, unchanged brief on failure, synthetic proposal acceptance, real export/import, mobile layout, Orbit iframe rendering; 0 JS errors. Successful real model conversation remains BLOCKED by provider auth.')
 b.close()
