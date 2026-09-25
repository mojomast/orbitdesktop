"""Four billed voice calls using synthetic test text/audio; no human recording."""
import json,io,wave
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
BASE='https://kimi.tailec998.ts.net:4366'
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(BASE);expect(page.locator('#vmodel option')).to_have_count(4)
    page.locator('#vrun').click();expect(page.locator('#vstatus')).to_contain_text('Authorize')
    evidence=[];synthetic=None
    for model in ['mimo-v2.5-tts','mimo-v2.5-tts-voicedesign','mimo-v2.5-asr','mimo-v2.5-tts-voiceclone']:
        page.locator('#vmodel').select_option(model)
        if model.endswith('-asr') or model.endswith('-voiceclone'):
            page.locator('#vfile').set_input_files({'name':'synthetic.wav','mimeType':'audio/wav','buffer':synthetic})
            if model.endswith('-voiceclone'):
                page.locator('#vconsent').check();page.locator('#vrun').click();expect(page.locator('#vstatus')).to_contain_text('permission');page.locator('#vrights').check()
        else:
            page.locator('#vtext').fill('Hello from Orbit. This is a short voice performance test.')
            page.locator('#vstyle').fill('A warm, clear adult narrator. Speak naturally in English.')
        page.locator('#vconsent').check()
        with page.expect_response(lambda r:r.url.endswith('/api/voice'),timeout=150000) as response:page.locator('#vrun').click()
        r=response.value;data=r.json();assert r.ok,(model,data)
        expect(page.locator('#vstatus')).to_contain_text('Complete.',timeout=15000)
        if model.endswith('-asr'):assert 'orbit' in data['text'].lower(),data['text']
        else:
            audio=page.locator('#vresults audio').first
            audio.evaluate('(a)=>a.play()');page.wait_for_function('()=>document.querySelector("#vresults audio").currentTime>0')
            with page.expect_download() as dl:page.locator('#vresults a').first.click()
            raw=Path(dl.value.path()).read_bytes()
            with wave.open(io.BytesIO(raw)) as w:assert w.getnframes()>0
            if model.endswith('-voicedesign'):synthetic=raw
        evidence.append({k:v for k,v in data.items() if k not in ('audio','usage')})
    assert not errors,errors
    page.locator('#vclear').click();expect(page.locator('#vresults')).to_be_empty()
    # Server guards: no paid calls for invalid requests.
    for payload in [{},{'model':'mimo-v2.5-tts','text':'Hi','consent':False}]:
        assert page.request.post(BASE+'/api/voice',headers={'Origin':BASE},data=payload).status==400
    assert page.request.post(BASE+'/api/voice',headers={'Origin':'https://evil.invalid'},data={}).status==403
    page.screenshot(path='/tmp/mimo-voice-lab.png',full_page=True)
    print(json.dumps({'browser':'PASS: consent, all four live models, upload, playback, WAV download, transcription, cloning permission, clear, server guards, no JS errors','results':evidence},indent=2))
    b.close()
