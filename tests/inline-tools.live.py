from pathlib import Path
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']); g=b.new_page(viewport={'width':1400,'height':1000}); errors=[]
 g.on('pageerror',lambda e:errors.append(str(e)))
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.keyboard.press('Escape')
 g.get_by_role('button',name='Connect local host',exact=True).click()
 g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN'])
 g.get_by_role('button',name='Unlock local host',exact=True).click()
 g.wait_for_timeout(5000) # Allow authenticated shared_chat registration before first submit.
 assert g.evaluate('localStorage.getItem("orbit.workspace.id")')!='eed047a8-e519-495e-a7ca-1c8c150a6ef4'
 g.get_by_role('button',name='Show inline tool calls and details',exact=True).click()
 expect(g.locator('.inline-tools')).to_be_visible()
 g.get_by_role('textbox',name='Message to Hermes').fill('Use only the terminal tool to run python3 -c "import time; time.sleep(3); print(123)" then reply done. Do not modify any files or use other tools.')
 g.get_by_role('button',name='Send message to Hermes',exact=True).click()
 expect(g.locator('.inline-tools-rows')).to_contain_text('terminal',timeout=180000)
 expect(g.locator('.agent-status')).to_have_text('COMPLETED',timeout=180000)
 summaries=g.locator('.inline-tool > summary').all_text_contents()
 assert any('Completed' in x for x in summaries),summaries
 g.locator('.inline-tool > summary').first.click()
 expect(g.locator('.inline-tool-detail').first).to_be_visible()
 print('PASS real authenticated run: inline terminal events and completion, expandable details, isolated workspace, no plugin required.')
 g.get_by_role('button',name='Load persisted tool arguments and results for this conversation',exact=True).click()
 expect(g.locator('.inline-tools-saved')).to_contain_text('print(123)',timeout=15000)
 print('PASS persisted real tool arguments loaded inline.')
 print('Tool summaries:',summaries)
 g.get_by_role('button',name='Show inline tool calls and details',exact=True).click()
 expect(g.locator('.inline-tools')).to_be_hidden()
 g.reload(wait_until='networkidle'); expect(g.locator('.inline-tools')).to_be_hidden()
 assert not errors,errors
 print('PASS toggle off persists after reload; no browser exceptions.')
 b.close()
