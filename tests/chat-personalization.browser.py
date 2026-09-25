from pathlib import Path
import json
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']); g=b.new_page(); errors=[]
 g.on('pageerror',lambda e:errors.append(str(e)))
 sent=[]; completed=set()
 def agent(route):
  d=route.request.post_data_json; a=d.get('action')
  if a=='start':
   sent.append(d['input']); result={'run_id':'test-'+str(len(sent))}
  elif a=='status': result={'status':'completed' if d['run_id'] in completed else 'working','output':'Test reply'}
  else: result={}
  route.fulfill(json=result)
 g.route('**/api/agent',agent)
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click()
 g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN'])
 g.get_by_role('button',name='Unlock local host',exact=True).click()
 title=g.get_by_role('textbox',name='Conversation title'); expect(title).to_be_visible()
 title.fill('Planning project')
 color=g.get_by_label('Conversation color theme'); color.fill('#8844cc'); color.dispatch_event('input')
 box=g.get_by_role('textbox',name='Message to Hermes'); box.fill('first'); box.press('Enter')
 expect(g.locator('.agent-status')).to_have_text('WORKING')
 box.fill('second'); box.press('Enter'); box.fill('third'); box.press('Enter')
 expect(g.locator('.agent-queue')).to_contain_text('second'); assert sent==['first']
 g.reload(wait_until='networkidle'); expect(title).to_have_value('Planning project'); expect(color).to_have_value('#8844cc')
 expect(g.locator('.agent-queue')).to_contain_text('third')
 # Reconnect host if token is not retained after reload.
 unlock=g.get_by_role('button',name='Connect local host',exact=True)
 if unlock.count() and unlock.is_visible():
  unlock.click(); g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']); g.get_by_role('button',name='Unlock local host',exact=True).click()
 completed.add('test-1')
 expect(g.locator('.chat-messages')).to_contain_text('second',timeout=15000)
 assert sent==['first','second'],sent
 completed.add('test-2')
 expect(g.locator('.chat-messages')).to_contain_text('third',timeout=15000)
 assert sent==['first','second','third'],sent
 assert not errors,errors
 print('PASS title/color/queue survive reload; queued messages dispatch FIFO only after completion; no browser errors (mock agent API).')
 b.close()
