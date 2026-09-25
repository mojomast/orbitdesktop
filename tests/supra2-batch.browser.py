"""Live isolated browser test: eight real CPU comparison images plus queue cancel."""
import json,urllib.request,urllib.error,time
from playwright.sync_api import sync_playwright,expect
BASE='https://kimi.tailec998.ts.net:4363'
def req(path,data=None,origin=BASE):
    r=urllib.request.Request(BASE+path,data=None if data is None else json.dumps(data).encode(),headers={'Origin':origin,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(r) as out:return out.status,json.load(out)
    except urllib.error.HTTPError as e:return e.code,json.load(e)
valid=dict(prompt='a tiny red sailboat, watercolor',count=2,steps=[2,4],guidance=[2,3])
assert not req('/api/status')[1]['busy'],'Owner is generating; defer test'
assert req('/api/batch',valid,'https://evil.example')[0]==403
for patch in [dict(count=0),dict(count=True),dict(steps=[]),dict(guidance=[float('nan')]),dict(count=32,steps=list(range(1,9)),guidance=[1,2])]:
    assert req('/api/batch',{**valid,**patch})[0]==400
try:urllib.request.urlopen('http://127.0.0.1:8677/api/status');raise AssertionError('auth')
except urllib.error.HTTPError as e:assert e.code==403
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page(viewport={'width':1500,'height':1050});errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('https://kimi.tailec998.ts.net:4325/')
    page.evaluate('''url=>{document.body.replaceChildren();const f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts allow-forms allow-same-origin allow-popups');f.src=url;f.style='width:1450px;height:1000px;border:0';document.body.append(f)}''',BASE)
    f=page.frame_locator('iframe');expect(f.locator('#badge')).to_contain_text('16 threads')
    f.locator('#prompt').fill(valid['prompt']);f.locator('#count').fill('2');f.locator('#compare').check();f.locator('#stepValues').fill('2, 4');f.locator('#guidanceValues').fill('2, 3')
    expect(f.locator('#estimate')).to_contain_text('8 images');f.locator('#generate').click()
    expect(f.locator('#cancel')).to_be_enabled(timeout=10000)
    assert req('/api/batch',valid)[0]==429
    expect(f.locator('#status')).to_contain_text('8 / 8 finished',timeout=240000)
    expect(f.locator('#history img')).to_have_count(8)
    data=req('/api/status')[1];batch=data['jobs'][0]['batch'];jobs=[j for j in data['jobs'] if j['batch']==batch]
    assert len(jobs)==8 and all(j['status']=='done' for j in jobs)
    assert len({j['seed'] for j in jobs})==2
    for seed in {j['seed'] for j in jobs}:assert {(j['steps'],j['cfg']) for j in jobs if j['seed']==seed}=={(2,2),(2,3),(4,2),(4,3)}
    f.locator('#sort').select_option('compare');f.locator('#history button').first.click()
    expect(f.locator('#detail')).to_be_visible();assert f.locator('#preview img').evaluate('(i)=>i.naturalWidth')==256
    with page.expect_popup() as pop:f.locator('#download').click()
    pop.value.wait_for_load_state();assert '/images/' in pop.value.url;pop.value.close()
    f.locator('#reuse').click();expect(f.locator('#fixed')).to_be_checked();expect(f.locator('#compare')).not_to_be_checked()
    # Snapshot only our test batch, never the owner's historical images.
    page.screenshot(path='/home/mojo/.hermes-instances/fresh/workspace/supra2-service/batch-gallery-test.png')
    studio=page.frames[1];studio.evaluate('location.reload()');expect(f.locator('#badge')).to_contain_text('16 threads');f.locator('#filter').select_option('latest');expect(f.locator('#history img')).to_have_count(8)
    page.set_viewport_size({'width':440,'height':1000});page.locator('iframe').evaluate("e=>e.style.width='410px'")
    assert studio.evaluate('document.documentElement.scrollWidth <= innerWidth')
    # Cancellation does not interrupt the current render, only waiting jobs.
    code,result=req('/api/batch',dict(prompt='a tiny red sailboat, watercolor',count=12,steps=[4],guidance=[3]));assert code==202
    assert req('/api/cancel',{})[0]==200
    deadline=time.time()+240
    while time.time()<deadline:
        d=req('/api/status')[1]
        if not d['busy']:break
        time.sleep(1)
    assert not d['busy'];cancelled=[j for j in d['jobs'] if j['batch']==result['batch']]
    assert any(j['status']=='cancelled' for j in cancelled)
    assert not any(j['status'] in ('running','queued') for j in cancelled)
    assert not errors,errors
    print('PASS: eight real PNGs; paired seeds; matrix metadata; gallery; inspector; popup; reuse; reload; mobile overflow; cancellation; auth/origin/bounds/concurrency; no JS errors.')
    print('Real batch timings:',[j['seconds'] for j in jobs]);b.close()
