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
 g.get_by_role('button',name='Hermes tools and conversations').click();g.get_by_role('button',name='Open published apps and outputs').click()
 published=g.get_by_role('button',name='Open published ',exact=False);expect(published.first).to_be_visible(timeout=15000);published.first.click()
 expect(g.locator('dialog iframe')).to_be_visible();g.locator('dialog').last.get_by_role('button',name='Close ',exact=False).click();g.get_by_role('button',name='Close Published apps and outputs',exact=True).click()
 g.get_by_role('textbox',name='Message to Hermes').fill('Use the terminal tool to run python3 -c "import time; time.sleep(8); print(\'ORBIT_LIVE_EVENT_OK\')" then reply done. Do not modify files.')
 g.get_by_role('button',name='Send message to Hermes',exact=True).click()
 expect(g.get_by_role('button',name='Send composer text to the active Hermes run')).to_be_visible(timeout=30000)
 g.get_by_role('button',name='Hermes tools and conversations').click();live=g.get_by_role('button',name='Open live Hermes activity');expect(live).to_be_enabled(timeout=15000);live.click()
 expect(g.get_by_role('dialog',name='Live Hermes activity').locator('details').first).to_be_visible(timeout=120000)
 expect(g.get_by_role('dialog',name='Live Hermes activity')).to_contain_text('tool',timeout=120000)
 g.get_by_role('button',name='Close Live Hermes activity').click()
 expect(g.locator('.agent-status')).to_have_text('COMPLETED',timeout=180000)
 assert not errors,errors
 print('PASS: real published shelf preview; capability-gated live Hermes SSE tool events; chat completion after closing stream; no JS errors.')
 b.close()
