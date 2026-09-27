from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={"width": 780, "height": 800})
    page.goto('http://127.0.0.1:4187/')
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
      assert(txt.includes('Events may be missed')===false,'warning only shown on reconnect');
      normal.connection('disconnected');assert(t.element.textContent.includes('Events may be missed; exact replay unavailable'),'precise reconnect warning');
      normal.connection('connected');
      const fail={version:1,id:'fail-id',at:1,authority:'recorder',category:'checks',kind:'Recorded check',summary:'Check failed <img src=x onerror=alert(1)>',status:'failed',target:'test-suite'};
      const complete={version:1,id:'complete-id',at:2,authority:'human',category:'evidence',kind:'Review',summary:'Reviewed safely',status:'completed',reference:{kind:'review',id:'safe-ref'}};
      t.upsert([fail,complete]);
      assert(!t.element.querySelector('img'),'all content is rendered as text');
      assert(t.element.textContent.includes('RECORDER')&&t.element.textContent.includes('YOU'),'all authority classes have text badges');
      const checks=[...t.element.querySelectorAll('.alt-filters button')].find(b=>b.textContent==='Checks');checks.click();
      assert(t.element.querySelectorAll('.alt-row').length===1&&t.element.textContent.includes('Check failed'),'category filter');
      const all=[...t.element.querySelectorAll('.alt-filters button')].find(b=>b.textContent==='All');all.click();
      const search=t.element.querySelector('input[type=search]');search.value='test-suite';search.dispatchEvent(new Event('input'));
      assert(t.element.querySelectorAll('.alt-row').length===1,'search includes safe target');search.value='';search.dispatchEvent(new Event('input'));
      const review=t.element.querySelector('[data-authority=human]');review.querySelector('summary').click();
      await new Promise(r=>setTimeout(r,0));assert(review.open,'historical row disclosure');
      assert(t.element.querySelector('button[aria-label^="Copy safe ID"]'),'safe ID copy action');
      [...review.querySelectorAll('button')].find(b=>b.textContent==='Open details').click();await new Promise(r=>setTimeout(r,0));assert(opened.length===1,'reference callback only');
      t.replace(Array.from({length:510},(_,i)=>({version:1,id:'row-'+i,at:i,authority:'observed',category:'tools',kind:'Tool',summary:'Event '+i,status:i===0?'failed':i===509?'running':'completed'})));
      assert(t.element.querySelectorAll('.alt-row').length===500,'presentation row budget');
      assert(t.element.querySelector('[data-status=failed]')&&t.element.querySelector('[data-status=running]'),'failure and active rows survive deterministic cap');
      t.element.querySelector('.alt-rows').scrollTop=0;await new Promise(r=>setTimeout(r,0));
      assert(t.element.querySelector('.alt-rows').scrollTop===0,'historical reading does not force-follow');
      t.element.querySelector('.alt-toolbar button:last-child').click();
      assert(t.element.querySelector('.alt-rows').scrollTop>0,'latest resumes follow');
      t.dispose();return 'PASS bounded safe timeline, Normal adapter, authorities, filters/search, refs, and follow';
    }''')
    print(result)
    browser.close()
