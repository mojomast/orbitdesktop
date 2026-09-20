from pathlib import Path
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1];env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);g=b.new_page(viewport={'width':1600,'height':1000})
 g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle');g.get_by_role('button',name='Connect local host',exact=True).click();g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN']);g.get_by_role('button',name='Unlock local host',exact=True).click();g.wait_for_timeout(1800);g.get_by_role('button',name='Focus Display 03',exact=True).click(force=True)
 g.get_by_role('textbox',name='Message to Hermes').fill('Read-only integration check. Use the workspace controller read command for this workspace, without modifying any files or workspace state. Then briefly name the script you should use to publish a new plugin, the operation to install it, the field that acknowledges browser application, and the terminal persistence mechanism. Derive these from the supplied workspace operator instructions. Never print capabilities or credentials.')
 g.get_by_role('button',name='Send message to Hermes',exact=True).click();g.wait_for_timeout(5000)
 if g.locator('.agent-status').inner_text()=='ATTENTION':raise RuntimeError(g.locator('.agent-progress').inner_text())
 expect(g.locator('.agent-status')).to_have_text('COMPLETED',timeout=240000)
 reply=g.locator('.chat-message.assistant').last.inner_text()
 for word in ['plugin_publish.py','plugin_install','tmux']:assert word.lower() in reply.lower(),reply
 assert 'browser_applied' in reply or 'observed_revision' in reply,reply
 g.get_by_role('button',name='Hermes tools and conversations').click();g.get_by_role('button',name='Inspect actual Hermes tool calls and results').click();expect(g.locator('.hermes-activity')).to_contain_text('workspace_control.py',timeout=15000)
 print('PASS: embedded Hermes used controller read and identified publisher, install operation, browser acknowledgement and tmux from injected guidance.')
 b.close()
