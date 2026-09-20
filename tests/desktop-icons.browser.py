from playwright.sync_api import sync_playwright, expect
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 page=b.new_page(viewport={'width':1440,'height':900});errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('https://kimi.tailec998.ts.net:4325/',wait_until='networkidle')
 expect(page.get_by_role('navigation',name='Desktop app shortcuts')).to_be_visible()
 # Keyboard activation works even when a window overlaps the desktop icon.
 for i in range(9):
  shortcut=page.locator('[data-shortcut="new-browser"]');shortcut.focus();shortcut.press('Enter')
 page.wait_for_timeout(400)
 state=page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
 assert len(state['monitors'])==12,len(state['monitors'])
 ids=[m['id'] for m in state['monitors']]
 page.reload(wait_until='networkidle')
 assert page.locator('.desktop-window').count()==12
 shortcut=page.locator('[data-shortcut="'+ids[0]+'"]');shortcut.focus();shortcut.press('Enter')
 page.wait_for_timeout(350)
 assert page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).selected')==ids[0]
 page.get_by_role('button',name='Show desktop shortcuts',exact=True).click()
 expect(page.locator('.desktop-window:not(.window-minimized)')).to_have_count(0)
 page.locator('[data-shortcut="'+ids[0]+'"]').click()
 expect(page.locator('.desktop-window:not(.window-minimized)')).to_have_count(1)
 assert not errors,errors
 print('PASS: Show Desktop minimizes without closing; mouse shortcut restores one existing window')
 print('PASS: desktop icons rendered, keyboard launches nine windows past old cap, 12 windows survive reload, shortcut selects existing window, no JS errors')
 b.close()
