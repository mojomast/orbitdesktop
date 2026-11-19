"""Real offline ASR + microphone + draft-insertion fixture. No owner workspace.

Explicit prerequisites: --models-root (provisioned, checksummed files) and
--audio-file (11-second JFK public US-government speech fixture, or equivalent
"ask not ... country" audio). Missing prerequisites are UNRUN (exit 2), not PASS.
"""
import argparse
import json
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import wave
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--models-root', type=Path, required=True)
parser.add_argument('--audio-file', type=Path, required=True)
args = parser.parse_args()
def wait_js(page, expression, timeout=30):
    # Playwright wait_for_function evaluates a string inside the page and needs
    # unsafe-eval. Poll through DevTools instead; preserve production WASM-only CSP.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.evaluate(expression): return
        page.wait_for_timeout(100)
    raise AssertionError({'timeout': expression, 'status': page.locator('.voice-status').inner_text() if page.locator('.voice-status').count() else 'disposed'})
if not args.models_root.is_dir() or not args.audio_file.is_file():
    print('UNRUN: provisioned local models/audio fixture missing')
    raise SystemExit(2)

with tempfile.TemporaryDirectory(prefix='orbit-voice-browser-', dir='/tmp/opencode') as temporary:
    scratch = Path(temporary)
    with wave.open(str(args.audio_file), 'rb') as audio:
        parameters, frames = audio.getparams(), audio.readframes(audio.getnframes())
    with wave.open(str(scratch / 'long.wav'), 'wb') as audio:
        audio.setparams(parameters); audio.writeframes(frames * 3)
    shutil.copytree(ROOT / 'src', scratch / 'src')
    (scratch / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    (scratch / 'fixture.html').write_text('<!doctype html><html><head><meta charset="utf-8"><title>Voice test</title></head><body><main id="host"></main><script type="module" src="/fixture.ts"></script></body></html>')
    (scratch / 'fixture.ts').write_text('''
import {mountVoiceCapture} from './src/voice-capture';
import {registerConversationRecipient} from './src/conversation-transfer';
window.calls=[];
registerConversationRecipient({id:'draft-a',title:'Draft A',receive:d=>{window.calls.push({target:'a',...d});return {accepted:true};}});
registerConversationRecipient({id:'draft-b',title:'Draft B',receive:d=>{window.calls.push({target:'b',...d});return {accepted:true};}});
window.mount=()=>window.view=mountVoiceCapture(document.querySelector('#host'),()=> 'never-exported-token');
window.mount(); window.ready=true;
''')
    csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'"
    (scratch / 'vite.config.mjs').write_text(f'''
import {{createVoiceModelAssets}} from {json.dumps(str(ROOT / 'server/voice-model-assets.mjs'))};
const assets=createVoiceModelAssets({{root:{json.dumps(str(ROOT))},modelsRoot:{json.dumps(str(args.models_root.resolve()))}}});
export default {{server:{{headers:{{'Content-Security-Policy':{json.dumps(csp)}}}}},plugins:[{{name:'voice-assets',configureServer(server){{server.middlewares.use((req,res,next)=>{{const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/vendor/voice/'))void assets.handle(req,res,url.pathname);else next();}});}}}}]}};
''')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    log = open(scratch / 'vite.log', 'w+')
    server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=scratch, stdout=log, stderr=log)
    try:
        for _ in range(150):
            if server.poll() is not None:
                log.seek(0); raise RuntimeError(log.read())
            try:
                urllib.request.urlopen(origin + '/fixture.html', timeout=1).close(); break
            except OSError: time.sleep(.1)
        else: raise RuntimeError('Vite readiness timeout')
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={args.audio_file.resolve()}'])
            context = browser.new_context(permissions=['microphone'])
            requests, external, errors, wasm = [], [], [], []
            context.on('request', lambda req: (requests.append(req.url), external.append(req.url) if not req.url.startswith(origin + '/') else None))
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('response', lambda response: wasm.append({'url': response.url, 'status': response.status, 'mime': response.headers.get('content-type')}) if response.url.endswith('.wasm') else None)
            page.goto(origin + '/fixture.html'); wait_js(page, 'window.ready === true')
            page.evaluate('''()=>{
              window.trackSets=[];window.micCalls=0;const real=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
              navigator.mediaDevices.getUserMedia=async (...args)=>{window.micCalls++;const s=await real(...args);window.trackSets.push(s.getTracks());return s;};
              window.workers=[];window.NativeWorker=window.Worker;
              window.idleSchedules=[];const timer=window.setTimeout.bind(window);
              window.setTimeout=(fn,delay,...args)=>{if(delay===60000){window.idleSchedules.push(delay);return timer(fn,1500,...args);}return timer(fn,delay,...args);};
              window.Worker=class extends window.NativeWorker {
                constructor(...args){super(...args);window.workers.push(this);this.ended=false;}
                terminate(){this.ended=true;super.terminate();}
              };
            }''')
            assert page.evaluate('window.micCalls') == 0
            page.get_by_role('button', name='Check local model').click()
            expect(page.locator('.voice-model-status')).to_contain_text('Local model verified', timeout=30000)
            began = time.monotonic()
            page.locator('.voice-file').set_input_files(args.audio_file)
            wait_js(page, "document.querySelector('.voice-status').textContent.startsWith('Ready for review') || document.querySelector('.voice-status').textContent.includes('failed')", timeout=180)
            text = page.locator('.voice-transcript').input_value()
            status = page.locator('.voice-status').inner_text()
            assert 'ask not' in text.lower() and 'country' in text.lower(), {'text': text, 'status': status, 'errors': errors}
            cold = time.monotonic() - began
            evidence = page.locator('.voice-provenance').inner_text()
            assert 'WASM, 1 thread' in evidence, evidence
            assert len(wasm) == 1 and '/ort-wasm-simd-threaded.wasm' in wasm[0]['url'] and wasm[0]['mime'] == 'application/wasm', wasm
            assert page.evaluate('crossOriginIsolated') is False
            warm_began = time.monotonic()
            page.locator('.voice-file').set_input_files(args.audio_file)
            wait_js(page, "document.querySelector('.voice-status').textContent.startsWith('Ready for review') || document.querySelector('.voice-status').textContent.includes('failed')", timeout=180)
            warm = time.monotonic() - warm_began
            assert 'ask not' in page.locator('.voice-transcript').input_value().lower()
            warm_evidence = page.locator('.voice-provenance').inner_text()
            assert page.evaluate('window.workers.length') == 1, 'Warm inference must reuse the loaded worker'
            page.locator('.voice-transcript').fill('Reviewed words, corrected by owner.')
            page.get_by_role('button', name='Choose draft').click()
            page.get_by_role('radio', name='Draft B').check()
            page.get_by_role('button', name='Insert into draft', exact=True).click()
            calls = page.evaluate('window.calls')
            assert len(calls) == 1 and calls[0]['target'] == 'b' and calls[0]['text'] == 'Reviewed words, corrected by owner.', calls
            assert not any('/api/' in url for url in requests), requests
            wait_js(page, 'window.workers[0].ended')
            assert page.evaluate('window.idleSchedules.every(ms=>ms===60000) && window.idleSchedules.length===2'), 'Idle worker cleanup not scheduled at 60 seconds'
            page.locator('.voice-file').set_input_files(scratch / 'long.wav')
            wait_js(page, "document.querySelector('.voice-status').textContent.startsWith('Ready for review') || document.querySelector('.voice-status').textContent.includes('failed')", timeout=180)
            long_text = page.locator('.voice-transcript').input_value()
            assert long_text.lower().count('country') >= 4, long_text
            long_evidence = page.locator('.voice-provenance').inner_text()
            assert 'audio 33.00 s' in long_evidence
            page.locator('.voice-transcript').fill('Reviewed words, corrected by owner.')

            # Real MediaRecorder, with fake audio device; stop releases tracks.
            page.get_by_role('button', name='Start recording', exact=True).click()
            wait_js(page, "document.querySelector('.voice-status').textContent.includes('Recording microphone')")
            page.wait_for_timeout(1800)
            page.get_by_role('button', name='Stop recording', exact=True).click()
            wait_js(page, "window.trackSets.every(ts=>ts.every(t=>t.readyState==='ended'))")
            page.get_by_role('button', name='Cancel', exact=True).click()
            expect(page.locator('.voice-transcript')).to_have_value('Reviewed words, corrected by owner.')
            assert page.evaluate('window.workers.every(w=>w.ended)'), 'Cancel did not terminate inference worker'

            # PTT release and permission race: a late stream must be stopped.
            page.evaluate('''()=>{
              const real=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
              navigator.mediaDevices.getUserMedia=async (...args)=>{const s=await real(...args);await new Promise(r=>setTimeout(r,500));return s;};
            }''')
            hold = page.get_by_role('button', name='Hold to record', exact=True)
            hold.hover(); page.mouse.down(); page.mouse.up(); page.wait_for_timeout(1000)
            assert page.evaluate("window.trackSets.every(ts=>ts.every(t=>t.readyState==='ended'))")
            page.get_by_role('button', name='Start recording', exact=True).click()
            wait_js(page, "document.querySelector('.voice-status').textContent.includes('Recording microphone')")
            page.evaluate('window.view.dispose()')
            assert page.evaluate("window.trackSets.every(ts=>ts.every(t=>t.readyState==='ended'))")

            # Supplement real inference with deliberately late mock-worker messages.
            # This verifies request identity and teardown, not recognition accuracy.
            page.evaluate('''()=>{
              window.fakeWorkers=[];
              window.Worker=class {
                constructor(){this.ended=false;window.fakeWorkers.push(this);}
                postMessage(request){this.request=request;this.late=this.onmessage;}
                terminate(){this.ended=true;}
              };
              window.mount();
            }''')
            page.locator('.voice-transcript').fill('Retain this edit on cancellation')
            page.locator('.voice-file').set_input_files(args.audio_file)
            wait_js(page, 'window.fakeWorkers.length===1 && !!window.fakeWorkers[0].request')
            page.get_by_role('button', name='Cancel', exact=True).click()
            page.evaluate("window.fakeWorkers[0].late({data:{type:'result',id:window.fakeWorkers[0].request.id,text:'STALE RESULT'}})")
            expect(page.locator('.voice-transcript')).to_have_value('Retain this edit on cancellation')
            assert page.evaluate('window.fakeWorkers[0].ended')
            page.locator('.voice-file').set_input_files(args.audio_file)
            wait_js(page, 'window.fakeWorkers.length===2 && !!window.fakeWorkers[1].request')
            page.evaluate('window.view.dispose()')
            assert page.evaluate('window.fakeWorkers[1].ended')
            page.evaluate("window.fakeWorkers[1].late({data:{type:'result',id:window.fakeWorkers[1].request.id,text:'DISPOSED RESULT'}})")
            assert page.locator('.voice-capture').count() == 0
            page.evaluate('window.mount()')
            page.route('**/vendor/voice/models/**', lambda route: route.fulfill(status=404))
            page.locator('.voice-transcript').fill('Keep this text when weights are missing')
            page.locator('.voice-file').set_input_files(args.audio_file)
            expect(page.locator('.voice-status')).to_contain_text('model_missing:', timeout=30000)
            expect(page.locator('.voice-transcript')).to_have_value('Keep this text when weights are missing')
            assert page.evaluate('window.fakeWorkers.length') == 2
            page.evaluate('window.view.dispose()')
            assert external == [], external
            assert errors == [], errors
            print(json.dumps({'status': 'PASS', 'coldDecodeLoadInferSeconds': round(cold, 3), 'warmDecodeInferSeconds': round(warm, 3), 'provenance': evidence, 'warmProvenance': warm_evidence, 'longProvenance': long_evidence, 'transcript': text, 'wasm': wasm, 'externalRequests': external, 'micCalls': page.evaluate('window.micCalls')}, indent=2))
            context.close(); browser.close()
    finally:
        server.terminate(); server.wait(timeout=10); log.close()
