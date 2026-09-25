import json, pathlib
from playwright.sync_api import sync_playwright, expect
ROOT=pathlib.Path(__file__).resolve().parents[1]
env={}
for line in (ROOT/'.env.deploy').read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        k,v=line.split('=',1);env[k]=v.strip().strip('"').strip("'")
W='eed047a8-e519-495e-a7ca-1c8c150a6ef4'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':412,'height':915},is_mobile=True,has_touch=True)
    page=context.new_page(); errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    # Test adapter supplies device bootstrap and upstream auth only in this isolated browser.
    # Production device-auth policy is tested separately, without a bypass in the service.
    page.route('**/api/mobile',lambda r:r.fulfill(json={'workspace_id':W}))
    def api(route):
        req=route.request
        data=req.post_data_json
        if req.url.endswith('/api/workspace'):
            assert data['action']=='read'
            data.pop('observed_revision',None)
        headers={**req.headers,'authorization':'Bearer '+env['ORBIT_TOKEN'],'origin':'http://127.0.0.1:4335'}
        response=route.fetch(headers=headers,post_data=json.dumps(data))
        route.fulfill(response=response)
    page.route('**/api/workspace',api);page.route('**/api/agent',api)
    page.goto('http://127.0.0.1:4335/mobile.html')
    expect(page.get_by_role('button',name='Choose desktop tab')).to_contain_text('Tabs ·')
    page.get_by_role('button',name='Choose desktop tab').click()
    expect(page.locator('.mobile-tab-card').first).to_be_visible()
    count=page.locator('.mobile-tab-card').count()
    live=json.loads(pathlib.Path('/tmp/orbit-mobile-state.json').read_text())['state']
    def leaves(l):return 1 if l['type']=='pane' else leaves(l['first'])+leaves(l['second'])
    assert count==sum(leaves(m['layout']) for m in live['monitors']),(count,live)
    page.get_by_role('searchbox').fill('Display 05')
    expect(page.locator('.mobile-tab-card')).to_have_count(3)
    page.locator('.mobile-tab-card').first.click()
    pane=page.locator('.mobile-stage>.pane:not([hidden])')
    pane_id=pane.get_attribute('data-pane-id')
    page.get_by_role('button',name='Customize this tab').click()
    for name,value in [('Text / app scale','22'),('Pane opacity','0.55')]:
        page.get_by_role('slider',name=name).fill(value)
    page.get_by_role('button',name='Close appearance settings').click()
    assert pane.evaluate('(e)=>getComputedStyle(e).opacity')=='0.55'
    assert page.locator('#mobile-root').evaluate('(e)=>getComputedStyle(e).backgroundImage')!='none'
    page.get_by_role('button',name='Next tab',exact=True).click()
    page.get_by_role('button',name='Previous tab',exact=True).click()
    assert pane.get_attribute('data-pane-id')==pane_id
    assert pane.evaluate('(e)=>getComputedStyle(e).opacity')=='0.55'
    page.reload()
    expect(page.locator('.mobile-stage>.pane:not([hidden])')).to_have_attribute('data-pane-id',pane_id)
    assert pane.evaluate('(e)=>getComputedStyle(e).opacity')=='0.55'
    for width,height in [(360,800),(412,915),(915,412)]:
        page.set_viewport_size({'width':width,'height':height})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert page.locator('.mobile-stage').bounding_box()['height']>200
    page.set_viewport_size({'width':412,'height':915})
    # Native fullscreen must preserve mounted panes and leave an exit control.
    page.get_by_role('button',name='Enter fullscreen',exact=True).click()
    page.wait_for_function('() => document.fullscreenElement === document.querySelector("#mobile-root")')
    expect(page.get_by_role('button',name='Exit fullscreen',exact=True)).to_be_visible()
    assert pane.get_attribute('data-pane-id')==pane_id
    page.get_by_role('button',name='Exit fullscreen',exact=True).click()
    page.wait_for_function('() => !document.fullscreenElement')
    # Explicitly simulate visual-viewport keyboard resize/pan, not a real Android keyboard.
    page.evaluate('''() => {
      window.testViewport = new EventTarget();
      Object.assign(window.testViewport,{height:515,width:412,offsetTop:35,offsetLeft:0});
      Object.defineProperty(window,'visualViewport',{configurable:true,value:window.testViewport});
      window.dispatchEvent(new Event('resize'));
    }''')
    page.wait_for_function('() => document.querySelector("#mobile-root").style.height === "515px"')
    for selector in ['.mobile-stage','.mobile-bottom']:
        box=page.locator(selector).bounding_box()
        assert box['y']+box['height']<=551,(selector,box)
    assert pane.get_attribute('data-pane-id')==pane_id
    page.evaluate("delete window.visualViewport; window.dispatchEvent(new Event('resize'))")
    page.reload()
    expect(page.get_by_role('button',name='Choose desktop tab')).to_contain_text('Tabs ·')
    # Rejected native fullscreen still offers reversible compact mode.
    page.evaluate("() => { document.querySelector('#mobile-root').requestFullscreen=()=>Promise.reject(new Error('test denied')); }")
    page.get_by_role('button',name='Enter fullscreen',exact=True).click()
    expect(page.get_by_role('button',name='Exit fullscreen',exact=True)).to_be_visible()
    page.get_by_role('button',name='Exit fullscreen',exact=True).click()
    expect(page.get_by_role('button',name='Enter fullscreen',exact=True)).to_be_visible()
    print('PASS: native fullscreen enter/exit, fallback compact mode, preserved pane identity, simulated keyboard viewport resize and pan keep tab/navigation above keyboard.')
    page.screenshot(path=str(ROOT/'.runtime/mobile/pocket-browser-test.png'))
    assert not errors,errors
    print(f'PASS: {count} live leaf tabs; split flattening, search, switching, retained pane IDs, per-tab scale/opacity, wallpaper, reload persistence, portrait/landscape; no page errors. Phone auth not simulated as a live Pixel connection.')
    browser.close()
