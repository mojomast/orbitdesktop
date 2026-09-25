import json,urllib.request,urllib.error,uuid
from playwright.sync_api import sync_playwright,expect
BASE='https://kimi.tailec998.ts.net:4364'
def req(url,data=None,headers=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers=headers or {})) as r:return r.status,r.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
assert req('http://127.0.0.1:4465/api/list')[0]==403
assert req('http://127.0.0.1:4465/api/list',headers={'Tailscale-User-Login':'other@example.com'})[0]==403
assert req(BASE+'/api/delete',{'name':'TEST_NEVER_EXISTS'},{'Origin':'https://evil.example','Content-Type':'application/json'})[0]==403
assert req(BASE+'/api/copy?name=MIMO_API_KEY')[0]==404
code,raw=req(BASE+'/api/list');assert code==200 and b'MIMO_API_KEY' in raw and b'"value"' not in raw
name='BROWSER_TEST_'+uuid.uuid4().hex.upper()
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox']);c=b.new_context(permissions=['clipboard-read','clipboard-write']);page=c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
    page.goto(BASE);expect(page.locator('#list')).to_contain_text('MIMO_API_KEY')
    page.locator('#name').fill(name);page.locator('#value').fill('disposable-test-value');page.locator('#save').click();expect(page.locator('#status')).to_have_text('Secret saved securely.')
    row=page.locator('article').filter(has_text=name);expect(row).to_be_visible();assert 'disposable-test-value' not in page.locator('body').inner_text();assert page.locator('#value').input_value()==''
    row.get_by_role('button',name='Copy',exact=True).click();expect(page.locator('#status')).to_contain_text('Copied.');assert page.evaluate('navigator.clipboard.readText()')=='disposable-test-value'
    row.get_by_role('button',name='Replace',exact=True).click();page.locator('#value').fill('replacement-test-value');page.locator('#save').click();expect(page.locator('#value')).to_have_value('');expect(page.locator('#formTitle')).to_have_text('Add a secret')
    row.get_by_role('button',name='Copy',exact=True).click();expect(page.locator('#status')).to_contain_text('Copied.');assert page.evaluate('navigator.clipboard.readText()')=='replacement-test-value'
    row.get_by_role('button',name='Delete',exact=True).click();expect(row).to_have_count(0);page.evaluate("navigator.clipboard.writeText('')")
    page.goto('https://kimi.tailec998.ts.net:4325/');page.evaluate('''url=>{document.body.replaceChildren();const f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts allow-forms allow-same-origin allow-popups');f.src=url;document.body.append(f)}''',BASE)
    expect(page.frame_locator('iframe').locator('#list')).to_contain_text('MIMO_API_KEY');assert not errors,errors;b.close()
print('PASS live authenticated HTTPS, rejected unauthenticated/other identity/cross-origin/GET-copy, masked listing, browser create/copy/replace/delete, no plaintext rendering, Orbit iframe rendering, no JS errors')
