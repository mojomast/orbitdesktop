from playwright.sync_api import sync_playwright, expect
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 for w,h in [(1440,900),(390,664),(900,450)]:
  page=b.new_page(viewport={'width':w,'height':h}); errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('https://kimi.tailec998.ts.net:4325/',wait_until='networkidle')
  start=page.get_by_role('button',name='Open Start',exact=True)
  start.click(); search=page.get_by_role('searchbox',name='Search Start')
  expect(search).to_be_focused()
  panel=page.locator('.start-panel'); rect=panel.bounding_box()
  assert rect['x']>=0 and rect['y']>=0 and rect['x']+rect['width']<=w,rect
  search.fill('zzzznoresult'); expect(page.locator('.start-empty')).to_be_visible()
  search.fill('New browser'); search.press('ArrowDown')
  expect(page.get_by_role('button',name='New browser',exact=True)).to_be_focused()
  page.keyboard.press('Enter'); expect(panel).to_be_hidden()
  page.wait_for_timeout(300)
  state=page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
  assert state['monitors'][-1]['layout']['pane']['kind']=='browser'
  start.click(); page.keyboard.press('Escape'); expect(start).to_be_focused(); expect(panel).to_be_hidden()
  start.click(); search.fill('Spatial view'); search.press('Enter')
  expect(page.locator('.workspace')).not_to_have_class(__import__('re').compile('windows-mode'))
  start.click(); search.fill('Windows view'); search.press('Enter')
  expect(page.locator('.workspace')).to_have_class(__import__('re').compile('windows-mode'))
  start.click(); page.locator('.brand').click(); expect(panel).to_be_hidden()
  bar=page.locator('.scene-navigation').bounding_box(); assert bar['x']>=0 and bar['x']+bar['width']<=w
  assert not errors,errors
  print(f'PASS {w}x{h}: launcher bounds, search, keyboard, create browser, Escape, view switching, outside dismissal, taskbar bounds; no JS errors')
  page.close()
 b.close()
