"""Live integration: five billed requests, one per text model, cap 32 each."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
BASE='https://kimi.tailec998.ts.net:4366'
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox'])
    page=b.new_page(viewport={'width':1500,'height':1100});errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(BASE)
    expect(page.locator('#model option')).to_have_count(6)
    page.locator('#model').select_option('all');page.locator('#samples').fill('1');page.locator('#max_tokens').fill('32')
    expect(page.locator('#budget')).to_contain_text('5 paid requests, up to 160')
    page.locator('#run').click();expect(page.locator('#status')).to_contain_text('Check Authorize')
    page.locator('#consent').check();page.locator('#run').click()
    expect(page.locator('#configuration')).to_contain_text('all',timeout=15000)
    expect(page.locator('#title')).to_contain_text('finished',timeout=240000)
    expect(page.locator('#comparison tr')).to_have_count(5)
    expect(page.locator('#rows tr')).to_have_count(5)
    expect(page.locator('#metrics')).to_contain_text('5/5')
    with page.expect_download() as dl:page.locator('#json').click()
    result=json.loads(Path(dl.value.path()).read_text())
    assert len({r['model'] for r in result['results']})==5
    with page.expect_download() as dl:page.locator('#csv').click()
    assert Path(dl.value.path()).read_text().startswith('model,index,')
    page.reload();expect(page.locator('#comparison tr')).to_have_count(5)
    assert not errors,errors
    print(json.dumps({'browser':'PASS model selection, budget, consent, live comparison, exports, history, no JS errors','results':[{k:r.get(k) for k in ['model','ok','error','quality_pass','ttft_ms']} for r in result['results']]},indent=2))
    b.close()
