import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
vite = root / 'node_modules' / '.bin' / 'vite'
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]

with tempfile.TemporaryDirectory(prefix='orbit-live-timeline-') as temp:
    server_log = open(Path(temp) / 'vite.log', 'w+')
    env = {**os.environ, 'TMPDIR': temp}
    server = subprocess.Popen([str(vite), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=root, env=env, stdout=server_log, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{port}/'
    try:
        for _ in range(100):
            if server.poll() is not None:
                raise RuntimeError('Disposable Vite server exited before becoming healthy')
            try:
                with urllib.request.urlopen(base, timeout=0.5) as response:
                    assert response.status == 200, 'disposable server health check'
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError('Disposable Vite server health check timed out')

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={"width": 780, "height": 800})
            page = context.new_page()
            page.goto(base)
            result = page.evaluate('''async () => {
              const {createLiveTimeline}=await import('/src/agent-live-timeline.ts');
              const {createNormalLiveAdapter}=await import('/src/agent-live-normal.ts');
              const assert=(v,m)=>{if(!v)throw Error(m)};
              document.body.replaceChildren();
              const host=document.createElement('div');host.style.cssText='height:420px;width:min(720px,96vw)';document.body.append(host);
              const opened=[];
              const t=createLiveTimeline({storageKey:'timeline-browser-fixture',onOpenReference:item=>opened.push(item.id)});
              host.append(t.element);
              const normal=createNormalLiveAdapter(t);normal.reset('binding-1');
              normal.event({event:'tool.started',tool:'read_file',tool_call_id:'c-1',arguments:'SECRET_ARGUMENT',reasoning:'SECRET_REASONING'});
              normal.event({event:'tool.completed',tool:'read_file',tool_call_id:'c-1',output:'SECRET_OUTPUT'});
              normal.saved([{kind:'call',name:'terminal',id:'saved-1',detail:'SECRET_SAVED_ARGS'},{kind:'result',name:'terminal',id:'saved-1',detail:'SECRET_SAVED_RESULT'}]);
              normal.status({status:'WAITING FOR APPROVAL',run:'r1'});
              let txt=t.element.textContent;
              assert(!/SECRET_(ARGUMENT|REASONING|OUTPUT|SAVED)/.test(txt),'raw payload/reasoning never enters timeline');
              assert(txt.includes('OBSERVED')&&txt.includes('AGENT'),'authority badges are literal');
              assert(!txt.includes('Events may be missed'),'warning only shown on reconnect');
              normal.connection('disconnected');assert(t.element.textContent.includes('Events may be missed; exact replay unavailable'),'precise reconnect warning');
              normal.connection('connected');
              const fail={version:1,id:'fail-id',at:1,authority:'recorder',category:'checks',kind:'Recorded check',summary:'Check failed <img src=x onerror=alert(1)>',status:'failed',target:'test-suite'};
              const complete={version:1,id:'complete-id',at:2,authority:'human',category:'evidence',kind:'Review',summary:'Reviewed safely',status:'completed',reference:{kind:'review',id:'safe-ref'}};
              t.upsert([fail,complete,{...complete,id:'invalid-authority',authority:'agent evil'}]);
              assert(!t.element.textContent.includes('agent evil'),'invalid runtime authority is rejected');
              assert(!t.element.querySelector('img'),'all content is rendered as text');
              assert(t.element.textContent.includes('RECORDER')&&t.element.textContent.includes('YOU'),'authority labels render');
              const checks=[...t.element.querySelectorAll('.alt-filters button')].find(b=>b.textContent==='Checks');checks.click();
              assert(t.element.querySelectorAll('.alt-row:not([hidden])').length===1&&t.element.textContent.includes('Check failed'),'category filter');
              assert(JSON.parse(localStorage.getItem('timeline-browser-fixture')).filter==='checks','filter preference persists');
              const all=[...t.element.querySelectorAll('.alt-filters button')].find(b=>b.textContent==='All');all.click();
              const search=t.element.querySelector('input[type=search]');search.value='test-suite';search.dispatchEvent(new Event('input'));
              assert(t.element.querySelectorAll('.alt-row:not([hidden])').length===1,'search includes safe target');search.value='';search.dispatchEvent(new Event('input'));
              assert(JSON.parse(localStorage.getItem('timeline-browser-fixture')).search==='','search preference persists');
              const review=t.element.querySelector('[data-authority=human]');review.querySelector('summary').click();
              await new Promise(r=>setTimeout(r,0));assert(review.open,'historical row disclosure');
              assert(t.element.querySelector('button[aria-label^="Copy safe ID"]'),'safe ID copy action');
              [...review.querySelectorAll('button')].find(b=>b.textContent==='Open details').click();await new Promise(r=>setTimeout(r,0));assert(opened.length===1,'reference callback only');
              normal.event({event:'tool.started',tool:'later_tool',tool_call_id:'later-1',timestamp:1700000000});
              assert(review.isConnected&&review.open,'keyed updates preserve open historical row');
              assert(review.querySelector('.alt-meta').textContent.length>0,'timestamp is visible');
              t.replace(Array.from({length:510},(_,i)=>({version:1,id:'row-'+i,at:i,authority:'observed',category:'tools',kind:'Tool',summary:'Event '+i,status:i===0?'failed':i===509?'running':'completed'})));
              assert(t.element.querySelectorAll('.alt-row:not([hidden])').length===500,'presentation row budget');
              assert(t.element.querySelector('[data-status=failed]')&&t.element.querySelector('[data-status=running]'),'failure and active rows survive deterministic cap');
              assert(t.element.querySelector('.alt-count').textContent.includes('500'),'visible event count');
              assert(t.element.querySelector('.alt-overflow').textContent.includes('omitted'),'overflow notice');
              const follow=t.element.querySelector('.alt-toolbar > button:last-child');
              assert(follow.textContent==='Resume following','expanded historical row pauses and labels follow: '+follow.textContent);
              follow.click();assert(follow.textContent==='Pause following','follow toggles explicitly on');
              follow.click();assert(follow.textContent==='Resume following','follow toggles explicitly off');
              const list=t.element.querySelector('.alt-rows');list.scrollTop=0;await new Promise(r=>setTimeout(r,0));
              const before=list.scrollTop;
              t.upsert([{version:1,id:'new-event',at:1000,authority:'observed',category:'tools',kind:'Tool',summary:'New event',status:'completed'}]);
              assert(list.scrollTop===before,'follow off does not auto-scroll');
              t.element.querySelector('.alt-toolbar > button:nth-last-child(2)').click();
              assert(list.scrollTop>before,'latest resumes follow');
              assert(JSON.parse(localStorage.getItem('timeline-browser-fixture')).follow===true,'follow preference persists');
              t.element.querySelector('.alt-toolbar > button:nth-of-type(1)').click();
              assert(JSON.parse(localStorage.getItem('timeline-browser-fixture')).density==='detailed','density preference persists');
              t.element.querySelector('.alt-toolbar > button:nth-of-type(2)').click();
              assert(JSON.parse(localStorage.getItem('timeline-browser-fixture')).collapseCompleted===true,'collapse preference persists');
              t.replace(Array.from({length:505},(_,i)=>({version:1,id:'active-'+i,at:i,authority:'observed',category:'tools',kind:'Tool',summary:'Active '+i,status:'running'})));
              assert(t.element.querySelector('.alt-overflow').textContent.includes('active/waiting/unknown priority events exceeded'),'protected overflow is explicit');
              t.upsert([{version:1,id:'warning-denied',at:600,authority:'agent',category:'warnings',kind:'Denied',summary:'Permission denied',status:'denied'},{version:1,id:'warning-unknown',at:601,authority:'observed',category:'warnings',kind:'Uncertain',summary:'Outcome unknown',status:'unknown'}]);
              t.element.querySelector('.alt-toolbar > button:nth-of-type(3)').click();
              assert(document.activeElement?.dataset.status==='unknown','first failure navigation includes unknown and focuses row');
              t.dispose();return 'PASS keyed rows, persisted controls, timestamps/counts/overflow, safe adapter, filters, authorities, references, follow, and retention';
            }''')
            print(result)
            context.close()
            browser.close()
    finally:
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
        server_log.close()
