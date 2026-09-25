from pathlib import Path
import json
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
ORIGIN='https://kimi.tailec998.ts.net:4325'
ENTRY='/apps/omnivoice-bench-d35a4fc207db2eb5944d344f/index.html'
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox'])
    page=b.new_page(viewport={'width':1120,'height':900})
    errors=[];console=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m:console.append(m.text) if m.type=='error' else None)
    page.route(ORIGIN+'/__omnibench_test__',lambda r:r.fulfill(content_type='text/html',body='<html><body style="margin:0"><iframe style="width:1100px;height:880px;border:0" sandbox="allow-scripts allow-forms allow-modals allow-downloads" src="'+ENTRY+'"></iframe></body></html>'))
    page.goto(ORIGIN+'/__omnibench_test__')
    frame=page.frame_locator('iframe').frame_locator('iframe')
    expect(frame.locator('h1')).to_have_text('OmniVoice bench',timeout=20000)
    expect(frame.locator('#status')).to_contain_text('CPU',timeout=20000)
    frame.get_by_role('button',name='Quiet character',exact=True).click()
    assert 'whisper' in frame.locator('#instruct').input_value()
    frame.get_by_text('Recipe library & export',exact=True).click()
    frame.locator('#recipeName').fill('Bench browser test · quiet character')
    frame.locator('#saveRecipe').click()
    expect(frame.locator('#notice')).to_have_text('Recipe saved on this host.')
    frame.locator('#text').fill('<script>literal text, never executed</script>')
    with page.expect_download() as dl:frame.locator('#export').click()
    data=json.loads(Path(dl.value.path()).read_text())
    assert data['version']==1 and isinstance(data['takes'],list)
    frame.locator('#import').set_input_files({'name':'invalid.json','mimeType':'application/json','buffer':b'{"recipe": {}}'})
    expect(frame.locator('#notice')).to_contain_text('Import failed')
    page.reload()
    expect(frame.locator('#status')).to_contain_text('CPU',timeout=20000)
    expect(frame.locator('#recipes')).to_contain_text('Bench browser test',timeout=10000)
    page.screenshot(path=str(ROOT/'.runtime/omnivoice-bench/browser-desktop.png'),full_page=True)
    page.set_viewport_size({'width':400,'height':850})
    page.locator('iframe').evaluate("e=>e.style.width='380px'")
    assert frame.locator('body').evaluate('e=>e.scrollWidth<=390'),'mobile overflow'
    page.screenshot(path=str(ROOT/'.runtime/omnivoice-bench/browser-mobile.png'),full_page=True)
    assert not errors,errors
    assert not console,console
    print('PASS: real published nested sandbox, authenticated CPU status, preset, persistent recipe, JSON download, invalid import rejection, reload persistence, mobile width; no JS/console errors')
    b.close()
