from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import json
root=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (root/'.env.deploy').read_text().splitlines() if '=' in x)
origin=env['ORBIT_PUBLIC_ORIGIN'].rstrip('/')
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox'])
    page=b.new_page(viewport={'width':650,'height':560})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(origin+'/apps/hermes-token-stats/')
    expect(page.locator('#oc-total')).not_to_have_text('—')
    expect(page.locator('#total')).not_to_have_text('—')
    sections=page.locator('section')
    assert sections.count()==2
    a,c=[sections.nth(i).bounding_box() for i in range(2)]
    assert c['x']>a['x']+a['width'] and abs(c['y']-a['y'])<1
    for summary in page.locator('summary').all():summary.click()
    assert page.locator('#oc-models .model').count()>0
    page.select_option('#scope','profile')
    assert page.locator('#models .model').count()>0
    data=page.evaluate("async()=>await (await fetch('./usage.json')).json()")
    oc=data['opencode']
    assert int(page.locator('#oc-total').inner_text().replace(',',''))==sum(oc[k] for k in ['input','output','cached','cache_write'])
    assert page.locator('#oc-models .model').count()==len(oc['models'])
    assert page.locator('#models .model').count()==len(data['profile']['models'])
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    for period in ['24h','7d','30d']:
        page.select_option('#period',period)
        page.select_option('#oc-period',period)
        expected=data['periods'][period]
        assert int(page.locator('#total').inner_text().replace(',',''))==expected['profile']['input']+expected['profile']['output']
        assert int(page.locator('#oc-total').inner_text().replace(',',''))==sum(expected['opencode'][k] for k in ['input','output','cached','cache_write'])
        assert page.locator('#models .model').count()==len(expected['profile']['models'])
    scope=page.locator('#scope').bounding_box(); period=page.locator('#period').bounding_box()
    assert abs(scope['y']-period['y'])<2 and period['x']>=scope['x']+scope['width']
    page.reload()
    # Sandboxed telemetry has an opaque origin: storage is unavailable on reload.
    expect(page.locator('#period')).to_have_value('all')
    expect(page.locator('#oc-period')).to_have_value('all')
    page.select_option('#period','all');page.select_option('#oc-period','all')
    page.screenshot(path=str(root/'.runtime/token-meters-desktop.png'))
    page.set_viewport_size({'width':340,'height':650})
    a,c=[sections.nth(i).bounding_box() for i in range(2)]
    assert c['y']>a['y']+a['height']
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.route('**/usage.json?*',lambda route:route.fulfill(json={**data,'opencode':{'available':False}}))
    page.locator('#oc-refresh').click()
    expect(page.locator('#oc-total')).to_have_text('—')
    expect(page.locator('#oc-status')).to_have_text('OpenCode usage unavailable')
    assert not errors,errors
    print('PASS live meters: adjacent desktop layout, mobile stacking, both model breakdowns, exact OpenCode total, unavailable state, no JS errors')
    b.close()
