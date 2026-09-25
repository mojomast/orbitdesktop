from playwright.sync_api import sync_playwright, expect
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox'])
    page=b.new_page(viewport={'width':850,'height':1600})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('https://kimi.tailec998.ts.net:4365/',wait_until='networkidle')
    expect(page.locator('#top-cpu .consumer-card').first).to_be_visible()
    page.locator('details').evaluate_all('(nodes)=>nodes.forEach(e=>e.open=true)')
    for selector in ['#models','#oc-models']:
        expect(page.locator(selector+' .model-card').first).to_be_visible()
        assert page.locator(selector+' .model-metrics').count()>0
    page.locator('#settings-toggle').click()
    for theme in ['nebula','graphite','mint','paper','glass']:
        page.select_option('#theme',theme)
        if theme=='glass':
            assert page.locator('.consumer-card').first.evaluate('(e)=>getComputedStyle(e).backgroundColor')=='rgba(0, 0, 0, 0)'
    for width in [320,650,850,1100]:
        page.set_viewport_size({'width':width,'height':1600})
        for layout in ['stacked','columns','compact']:
            page.select_option('#layout',layout)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,layout)
    page.select_option('#grouping','processes')
    expect(page.locator('#top-cpu .process-name small').first).to_contain_text('PID')
    page.select_option('#grouping','apps')
    page.select_option('#rows','3')
    expect(page.locator('#top-cpu .consumer-card')).to_have_count(3)
    page.locator('#settings-toggle').click()
    page.screenshot(path='.runtime/telemetry-cards.png',full_page=True)
    assert not errors,errors
    print('PASS live Hermes/OpenCode model cards, CPU/memory cards, themes/transparency, grouped/PID modes, ranking limits, 12 responsive layouts; no JS errors')
    b.close()
