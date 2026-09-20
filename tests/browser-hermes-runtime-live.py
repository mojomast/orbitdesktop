from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (ROOT/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000});errors=[]
 g.on('pageerror',lambda e:errors.append(str(e)))
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click()
 g.wait_for_timeout(1800);g.get_by_role('button',name='Focus Display 03',exact=True).click(force=True)
 text=g.get_by_role('textbox',name='Message to Hermes')
 text.fill('Run this exact harmless command with your terminal tool in the foreground: python3 -c "import time; print(\'ORBIT_ACTIVITY_REAL\', flush=True); time.sleep(15)". After the tool returns, respond ORIGINAL unless you receive guidance changing the final answer. This is an integration test; do not modify any files.')
 g.get_by_role('button',name='Send message to Hermes',exact=True).click()
 expect(g.get_by_role('button',name='Send composer text to the active Hermes run')).to_be_visible(timeout=30000)
 text.fill('Change the final answer: reply only ORBIT_STEER_ACCEPTED after the tool finishes.')
 for _ in range(20):
  g.get_by_role('button',name='Send composer text to the active Hermes run').click()
  try:
   expect(g.locator('.chat-message.user').last).to_contain_text('[Guidance to active run]',timeout=1000);break
  except AssertionError:g.wait_for_timeout(250)
 else:raise AssertionError('Guidance was never accepted')
 expect(g.locator('.agent-status')).to_have_text('COMPLETED',timeout=180000)
 expect(g.locator('.chat-message.assistant').last).to_contain_text('ORBIT_STEER_ACCEPTED')
 g.get_by_role('button',name='Hermes tools and conversations').click();g.get_by_role('button',name='Inspect actual Hermes tool calls and results').click()
 expect(g.locator('.hermes-activity')).to_contain_text('terminal',timeout=15000)
 expect(g.locator('.hermes-activity')).to_contain_text('ORBIT_ACTIVITY_REAL')
 assert not errors,errors
 print('PASS: real Hermes run accepted mid-turn guidance, changed final response, and exposed actual terminal call/result in Orbit.',flush=True)
 b.close()
