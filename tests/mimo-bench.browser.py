import json,urllib.request,urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
BASE='https://kimi.tailec998.ts.net:4366'
def req(url,data=None,headers=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers=headers or {}),timeout=20) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as e:return e.code,json.load(e)
assert req('http://127.0.0.1:4468/api/runs')[0]==403
assert req('http://127.0.0.1:4468/api/runs',headers={'Tailscale-User-Login':'other@example.com'})[0]==403
assert req(BASE+'/api/run',{}, {'Content-Type':'application/json','Origin':'https://evil.example'})[0]==403
assert req(BASE+'/api/run',{}, {'Content-Type':'application/json','Origin':BASE})[0]==400
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page(viewport={'width':1400,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('https://kimi.tailec998.ts.net:4325/');page.evaluate('''url=>{document.body.replaceChildren();const f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts allow-forms allow-same-origin allow-popups');f.style='width:1400px;height:1100px';f.src=url;document.body.append(f)}''',BASE)
    f=page.frame_locator('iframe');expect(f.locator('h1')).to_have_text('MiMo Performance Lab')
    f.locator('#run').click();expect(f.locator('#status')).to_contain_text('Check Authorize')
    f.locator('#preset').select_option('json');f.locator('#samples').fill('1');f.locator('#max_tokens').fill('64');f.locator('#consent').check();f.locator('#run').click()
    expect(f.locator('#title')).to_contain_text('json',timeout=15000);expect(f.locator('#title')).to_contain_text('finished',timeout=180000)
    expect(f.locator('#rows tr')).to_have_count(1);expect(f.locator('#rows')).to_contain_text('PASS');expect(f.locator('#consent')).not_to_be_checked()
    page.goto(BASE)
    expect(page.locator('#title')).to_contain_text('finished')
    with page.expect_download() as dl:page.locator('#json').click()
    exported=json.loads(Path(dl.value.path()).read_text());assert len(exported['results'])==1
    with page.expect_download() as dl:page.locator('#csv').click()
    assert 'ttft_ms' in Path(dl.value.path()).read_text()
    page.screenshot(path='/home/mojo/.hermes-instances/fresh/workspace/orbitdesktop/.runtime/mimo-bench/dashboard.png',full_page=True)
    page.reload();expect(page.locator('#rows tr')).to_have_count(1);assert not errors,errors;b.close()
print(json.dumps({'browser_checks':'PASS auth, CSRF, input validation, consent gating, real run inside actual Orbit sandbox permissions, JSON/CSV exports in top-level tab, history reload, no JS errors','live_summary':exported['summary']},indent=2))
