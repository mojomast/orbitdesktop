from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(permissions=['clipboard-read', 'clipboard-write'], viewport={'width':1400,'height':1000})
    page = context.new_page()
    page.goto('https://kimi.tailec998.ts.net:4325/', wait_until='networkidle')
    page.evaluate('''() => {
      const s=JSON.parse(localStorage.getItem('orbit.workspace.v1'));
      s.view='windows'; s.plugins=[]; s.monitors=s.monitors.slice(0,1);
      const m=s.monitors[0]; m.frame={x:10,y:10,width:1200,height:850,z:1};
      m.layout={type:'pane',pane:{id:'copy-test',kind:'terminal',url:'orbit://welcome'}};
      s.selected=m.id; localStorage.setItem('orbit.workspace.v1',JSON.stringify(s));
    }''')
    page.reload(wait_until='networkidle')
    if page.get_by_role('button', name='Skip', exact=True).count():
        page.get_by_role('button', name='Skip', exact=True).click()
    page.keyboard.press('Escape')
    page.wait_for_timeout(500)
    copy=page.get_by_role('button',name='Copy selected terminal text',exact=False)
    expect(copy).to_be_disabled()
    screen=page.locator('.xterm-screen').first
    box=screen.bounding_box()
    page.mouse.move(box['x']+2,box['y']+10)
    page.mouse.down()
    page.mouse.move(box['x']+260,box['y']+10,steps=20)
    page.mouse.up()
    expect(copy).to_be_enabled()
    copy.click()
    expect(page.locator('.terminal-copy-status')).to_have_text('Copied')
    text=page.evaluate('navigator.clipboard.readText()')
    assert 'ORBIT' in text, repr(text)
    page.locator('.xterm-helper-textarea').focus()
    for key in ['Control+Shift+C','Control+c']:
        page.evaluate("navigator.clipboard.writeText('reset')")
        page.keyboard.press(key)
        page.wait_for_timeout(150)
        assert page.evaluate('navigator.clipboard.readText()') == text
    page.mouse.click(box['x']+400,box['y']+120)
    expect(copy).to_be_disabled()
    page.keyboard.press('Control+Shift+C')
    expect(page.locator('.terminal-copy-status')).to_have_text('Select text first')
    page.get_by_role('button',name='Open native terminal text selection').click()
    dialog=page.get_by_role('dialog',name='Terminal text selection')
    text=page.get_by_role('textbox',name='Terminal scrollback text')
    expect(dialog).to_be_visible()
    assert 'ORBIT / LOCAL TERMINAL' in text.input_value()
    text.press('Control+a')
    text.press('Control+c')
    assert page.evaluate('navigator.clipboard.readText()') == text.input_value()
    box=text.bounding_box()
    page.mouse.move(box['x']+5,box['y']+12)
    page.mouse.down()
    page.mouse.move(box['x']+160,box['y']+12,steps=10)
    page.mouse.up()
    expect(dialog).to_be_visible()
    assert text.evaluate('(t)=>t.selectionEnd>t.selectionStart')
    text.press('Escape')
    expect(dialog).to_have_count(0)
    page.get_by_role('button',name='Paste system clipboard into terminal',exact=True).click()
    expect(page.locator('.terminal-copy-status')).to_have_text('Connect shell first')
    print('PASS live built frontend: xterm copy shortcuts; native snapshot, real OS clipboard roundtrip, selection survives mouse release, Escape, disconnected paste guard. Isolated workspace; no owner shell touched.')
    browser.close()
