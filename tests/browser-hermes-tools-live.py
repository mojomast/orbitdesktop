from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (ROOT/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000});errors=[]
 g.on('pageerror',lambda e:errors.append(str(e)))
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Focus Display 03',exact=True).click(force=True)
 text=g.get_by_role('textbox',name='Message to Hermes')
 text.fill('Draft survives reload')
 g.reload(wait_until='networkidle');expect(text).to_have_value('Draft survives reload')
 g.get_by_role('button',name='Focus Display 03',exact=True).click(force=True)
 g.get_by_role('button',name='Hermes tools and conversations').click()
 g.get_by_role('button',name='Inspect workspace',exact=True).click()
 expect(text).to_have_value('Inspect this workspace using the workspace controller. Summarize its current windows, panes, layout, and available controls. Do not change anything yet.')
 g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click()
 g.wait_for_timeout(2000)
 text.fill('Remember the code ORBIT_ARCHIVE_739 for this conversation. Reply only with that code.');g.get_by_role('button',name='Send message to Hermes',exact=True).click()
 expect(g.locator('.agent-status')).to_have_text('COMPLETED',timeout=120000)
 expect(g.locator('.chat-message.assistant').last).to_contain_text('ORBIT_ARCHIVE_739')
 g.get_by_role('button',name='Start a separate Hermes conversation').click()
 g.get_by_role('button',name='Hermes tools and conversations').click()
 g.get_by_role('button',name='Restore conversation: Remember the code ORBIT_ARCHIVE_739',exact=False).click()
 expect(g.locator('.chat-message.assistant').last).to_contain_text('ORBIT_ARCHIVE_739')
 text.fill('What code did I ask you to remember? Reply with only the code.');g.get_by_role('button',name='Send message to Hermes',exact=True).click()
 expect(g.locator('.agent-status')).to_have_text('COMPLETED',timeout=120000)
 expect(g.locator('.chat-message.assistant').last).to_contain_text('ORBIT_ARCHIVE_739')
 g.get_by_role('button',name='Hermes tools and conversations').click()
 with g.expect_download() as download:g.get_by_role('button',name='Download this Hermes conversation').click()
 assert 'ORBIT_ARCHIVE_739' in Path(download.value.path()).read_text()
 assert not errors,errors
 print('PASS: draft reload, shortcut, real Hermes response, archive/restore, server-side follow-up memory, transcript download, no JavaScript errors',flush=True)
 b.close()
