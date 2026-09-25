"""Real tailnet + sandboxed browser integration test; performs one CPU generation."""
import io,json,urllib.request,urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
BASE='https://kimi.tailec998.ts.net:4363'
def request(path,data=None,origin=BASE):
    headers={'Origin':origin,'Content-Type':'application/json'}
    req=urllib.request.Request(BASE+path,data=json.dumps(data).encode() if data is not None else None,headers=headers)
    try:
        with urllib.request.urlopen(req) as r: return r.status,r.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
valid={'prompt':'a small red sailboat on a turquoise sea, watercolor','seed':42,'steps':20,'cfg':3}
assert request('/api/generate',valid,'https://evil.example')[0]==403
for bad in [{**valid,'steps':0},{**valid,'seed':True},{**valid,'cfg':float('nan')},{**valid,'extra':1},{**valid,'prompt':' '}]:
    assert request('/api/generate',bad)[0]==400
try: urllib.request.urlopen('http://127.0.0.1:8678/api/status');raise AssertionError('unauthenticated accepted')
except urllib.error.HTTPError as e: assert e.code==403
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page(viewport={'width':1200,'height':950});errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m: print('BROWSER',m.type,m.text) if m.type=='error' else None)
    page.on('requestfailed',lambda r:print('REQUEST_FAILED',r.url,r.failure))
    # A separate synthetic parent at the real Orbit origin, same iframe policy as panes.ts.
    page.goto('https://kimi.tailec998.ts.net:4325/')
    page.evaluate('''url=>{document.body.replaceChildren();const f=document.createElement('iframe');f.title='studio';f.setAttribute('sandbox','allow-scripts allow-forms allow-same-origin allow-popups');f.src=url;f.style='width:1150px;height:900px;border:0';document.body.append(f)}''',BASE+'/')
    f=page.frame_locator('iframe')
    expect(f.locator('#badge')).to_contain_text('16 threads',timeout=20000)
    f.locator('#fixed').check()
    f.locator('#prompt').fill(valid['prompt']);f.locator('#seed').fill('42');f.locator('#steps').fill('20')
    f.locator('#generate').click();expect(f.locator('#generate')).to_be_disabled()
    assert request('/api/generate',valid)[0]==429
    expect(f.locator('#status')).to_contain_text('1 / 1 finished',timeout=240000)
    f.locator('#history button').first.click()
    expect(f.locator('#preview img')).to_be_visible(timeout=240000)
    assert f.locator('#preview img').evaluate('(img)=>img.naturalWidth')==256
    expect(f.locator('#meta')).to_contain_text('Seed 42')
    with page.expect_popup() as pop:f.locator('#download').click()
    pop.value.wait_for_load_state();assert '/images/' in pop.value.url
    print('REAL_GENERATION',f.locator('#meta').inner_text())
    expect(f.locator('#generate')).to_be_enabled(timeout=10000)
    old_src = f.locator('#preview img').get_attribute('src')
    f.locator('#detailClose').click()
    f.locator('#generate').click()
    expect(f.locator('#status')).to_contain_text('1 / 1 finished',timeout=240000)
    expect(f.locator('#generate')).to_be_enabled(timeout=240000)
    f.locator('#history button').first.click()
    expect(f.locator('#meta')).to_contain_text('warm reuse',timeout=240000)
    assert f.locator('#preview img').get_attribute('src') != old_src
    expect(f.locator('#badge')).to_have_text('CPU · warm · 16 threads',timeout=10000)
    print('WARM_GENERATION',f.locator('#meta').inner_text())
    page.screenshot(path='/home/mojo/.hermes-instances/fresh/workspace/supra2-service/studio-browser-test.png')
    assert not errors,errors
    b.close()
print('PASS: real 256px generation inside matching Orbit iframe sandbox; save-image popup; unauthenticated/origin/bounds/NaN/extra-fields rejected; concurrent generation rejected; no JS errors.')
