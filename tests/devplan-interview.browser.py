from pathlib import Path
import json
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
c=json.loads((R/'.runtime/devplan-interview/config.json').read_text())
env=dict(line.split('=',1) for line in (R/'.env.deploy').read_text().splitlines() if '=' in line)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(c['public_origin'])
 page.get_by_label('Orbit host token').fill(env['ORBIT_TOKEN'].strip().strip('"'))
 page.get_by_role('button',name='Unlock interview',exact=True).click()
 expect(page.get_by_role('button',name='Send answer',exact=True)).to_be_enabled(timeout=30000)
 page.locator('#chat-message').fill('I want to build SeedShelf, a local browser app for gardeners to track seed packets and expiry dates. Only I use it. First release should add packets and filter expired ones. No cloud sync. Ask me a focused follow-up and propose the known brief fields.')
 page.get_by_role('button',name='Send answer',exact=True).click()
 expect(page.get_by_role('button',name='Accept proposed updates',exact=True)).to_be_visible(timeout=270000)
 assert page.locator('#interview-log article').count()==2
 assert page.evaluate('Object.keys(state.answers).length')==0
 page.get_by_role('button',name='Accept proposed updates',exact=True).click()
 assert page.evaluate('state.answers.name')
 page.locator('#chat-message').fill('Store everything locally in this browser, with JSON export and import for backups. No login. What is the next important decision?')
 page.get_by_role('button',name='Send answer',exact=True).click()
 expect(page.locator('#interview-log article')).to_have_count(4,timeout=270000)
 assert page.evaluate('state.interview[3].content')
 if page.get_by_role('button',name='Accept proposed updates',exact=True).count():page.get_by_role('button',name='Accept proposed updates',exact=True).click()
 with page.expect_download() as d:page.locator('#save').click()
 target=R/'.runtime/devplan-interview/test-project.json';d.value.save_as(target)
 saved=json.loads(target.read_text());assert len(saved['interview'])==4
 assert page.evaluate('D.parseProject(JSON.parse(JSON.stringify(state))).interview.length')==4
 page.set_viewport_size({'width':390,'height':844})
 assert page.locator('body').evaluate('e=>e.scrollWidth<=window.innerWidth'),'Mobile overflow'
 assert not errors,errors
 print(json.dumps({'real_model_turns':2,'proposal_approval':True,'transcript_export_import':True,'page_errors':errors,'last_question':saved['interview'][-1]['content']}))
 b.close()
