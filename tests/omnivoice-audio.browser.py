from pathlib import Path
import json, time, wave
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
ORIGIN='https://kimi.tailec998.ts.net:4325'
ENTRY='/apps/omnivoice-bench-d35a4fc207db2eb5944d344f/index.html'
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox'])
    page=b.new_page(viewport={'width':1120,'height':950});errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route(ORIGIN+'/__omnibench_audio__',lambda r:r.fulfill(content_type='text/html',body='<html><body style="margin:0"><iframe style="width:1100px;height:930px;border:0" sandbox="allow-scripts allow-forms allow-modals allow-downloads" src="'+ENTRY+'"></iframe></body></html>'))
    page.goto(ORIGIN+'/__omnibench_audio__')
    f=page.frame_locator('iframe').frame_locator('iframe')
    expect(f.locator('#status')).to_contain_text('CPU',timeout=20000)
    f.locator('#label').fill('Browser-verified comparison · seed 43')
    f.locator('#text').fill('Hello. Welcome to the voice lab.')
    f.locator('#seed').fill('43');f.locator('#num_step').fill('8')
    f.locator('#generate').click()
    expect(f.locator('#notice')).to_contain_text('Take queued',timeout=10000)
    card=f.locator('article').filter(has=f.get_by_role('heading',name='Browser-verified comparison · seed 43',exact=True)).first
    expect(card.locator('.badge')).to_have_text('done',timeout=240000)
    card.get_by_role('button',name='→ B',exact=True).click()
    reference=f.locator('article').filter(has=f.get_by_role('heading',name='Verified smoke test · seed 42',exact=True)).filter(has=f.locator('.badge.done')).first
    reference.get_by_role('button',name='→ A',exact=True).click()
    for side in ['A','B']:
        f.locator('#slot'+side).get_by_role('button',name='Load audio',exact=False).click()
        expect(f.locator('#slot'+side+' audio')).to_have_count(1)
        audio=f.locator('#slot'+side+' audio')
        audio.evaluate('a=>a.play()')
        time.sleep(.4)
        assert audio.evaluate('a=>a.duration>0 && a.currentTime>0 && !a.error')
    assert f.locator('#slotA audio').evaluate('a=>a.paused'),'A/B playback overlapped'
    notes=card.locator('textarea.notes');notes.fill('Browser verification: WAV decoded and played; seed 43 compared against seed 42.');notes.blur()
    expect(card.locator('.note-state')).to_have_text('Saved',timeout=10000)
    card.get_by_role('button',name='☆ Favorite',exact=True).click()
    with page.expect_download() as dl:card.get_by_role('button',name='Download WAV',exact=True).click()
    with wave.open(str(dl.value.path()),'rb') as wav:
        assert wav.getframerate()==24000 and wav.getnframes()>0
        print('Downloaded actual WAV:',wav.getnframes(),'frames at',wav.getframerate(),'Hz')
    with page.expect_download() as recipe_download:card.get_by_role('button',name='Export recipe',exact=True).click()
    recipe=json.loads(Path(recipe_download.value.path()).read_text());assert recipe['recipe']['seed']==43
    f.get_by_text('Recipe library & export',exact=True).click()
    f.locator('#import').set_input_files({'name':'verified-recipe.json','mimeType':'application/json','buffer':json.dumps(recipe).encode()})
    expect(f.locator('#seed')).to_have_value('43')
    f.locator('#text').fill('Hello. Welcome to the voice lab.')
    page.screenshot(path=str(ROOT/'.runtime/omnivoice-bench/verified-audio-desktop.png'),full_page=True)
    page.reload();expect(f.locator('#status')).to_contain_text('CPU',timeout=20000)
    card=f.locator('article').filter(has=f.get_by_role('heading',name='Browser-verified comparison · seed 43',exact=True)).first
    expect(card.locator('textarea.notes')).to_have_value('Browser verification: WAV decoded and played; seed 43 compared against seed 42.')
    expect(card.get_by_role('button',name='★ Favorite',exact=True)).to_be_visible()
    assert not errors,errors
    print('PASS: browser Generate -> real Studio WAV; A/B decode and playback; non-overlapping playback; notes/favorite persisted across reload; real WAV and recipe downloads; recipe import; no JS errors')
    b.close()
