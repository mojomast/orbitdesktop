// Offline Linux/Chromium Hive QA. Run with TMPDIR and CHROMIUM_EXECUTABLE set:
// node tests/hive-density.browser.mjs ../evidence/density.json [--fast]
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = path.join(root, 'apps/rizzstack-hive');
const output = process.argv[2];
const fast = process.argv.includes('--fast'); // Frame, AX and latency gates only. Default still runs all three soaks.
assert.ok(output && process.env.TMPDIR && process.env.CHROMIUM_EXECUTABLE,
  'Supply density JSON path, TMPDIR and CHROMIUM_EXECUTABLE');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Freeze bytes for an entire trial, even when another worktree contributor is active.
const assets = new Map();
for (const name of (await fs.readdir(app)).sort()) {
  if (/^[\w-]+\.(?:js|css|html)$/.test(name)) assets.set(name, await fs.readFile(path.join(app,name)));
}
// Pinned upstream excerpt, so standalone Orbit CI needs no sibling checkout.
const hivespec = JSON.parse(await fs.readFile(new URL('./fixtures/hive-density-budgets.json', import.meta.url), 'utf8'));
assert.ok(hivespec.budgets.includes('14 attempts/500 retained marks') && hivespec.budgets.includes('<=500 normal nodes'));
const report = {
  started: new Date().toISOString(), gitBase: execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),
  bytesServedSha256: Object.fromEntries([...assets].map(([name,b]) => [name,hash(b)])),
  testSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
  hivespec,
  environment: {platform:os.platform(), arch:os.arch(), kernel:os.release(), cpu:os.cpus()[0]?.model,
    node:process.version, chromiumExecutable:process.env.CHROMIUM_EXECUTABLE, tmpdir:process.env.TMPDIR},
  limits: ['Synthetic views via a disposable same-origin test parent; no Orbit, credentials, live worker or Rails network.',
    '200% layout equivalent = 720×450 CSS px at DPR 2 for a 1440×900 output; not native desktop zoom UI.',
    'Automated Chromium AX names, states, and keyboard checks; no screen-reader user test or WCAG conformance claim.',
    'The synthetic parent retains 500 history records and sends the newest 200 per accepted guest view. The separate scene microbenchmark passes 500 retained records directly; the floor consumes no rail-mark timeline. No R12/backend or actual Rails synopsis qualification.',
    'JS heap includes same-renderer harness, Playwright instrumentation and guest. Periodic forced GC affects timing. Two-minute trends do not establish or exclude a leak.',
    'Production cadence, 30-minute reconnect soak, real Orbit sandbox and Windows/native mobile devices not tested.'],
  run:fast?'fast (no soaks)':'full', checks: [], errors: [], exceptions: [], offsite: [], soaks: [],
};
const check = (name, pass, observed) => {
  report.checks.push({name, pass:!!pass, ...(observed === undefined ? {} : {observed})});
  if (!pass) console.log('FAIL',name, JSON.stringify(observed));
};
const percentile = (values,p) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const summary = values => ({n:values.length, min:Math.min(...values), median:percentile(values,.5),
  p95:percentile(values,.95), max:Math.max(...values)});
const safe = async (name, fn) => {
  console.log('START', name);
  try { await fn(); } catch (err) { report.exceptions.push({name,error:String(err.stack || err)}); console.error(name,err); }
};
const resources = {js:'text/javascript', css:'text/css', html:'text/html'};
let requests=0;
const server=http.createServer((req,res)=>{
  requests++;
  const name=new URL(req.url,'http://localhost').pathname.slice(1);
  if (req.method==='GET' && name==='density-host.html') return res.writeHead(200,{'Content-Type':'text/html'}).end(
    '<!doctype html><meta charset=utf-8><title>Synthetic load only</title><style>*{margin:0;border:0}iframe{width:100vw;height:100vh;display:block}</style>');
  if (req.method!=='GET' || !assets.has(name)) return res.writeHead(404).end();
  res.writeHead(200,{'Content-Type':resources[name.split('.').at(-1)], 'Cache-Control':'no-store'}).end(assets.get(name));
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
async function context(options={}) {
  const ctx=await browser.newContext({serviceWorkers:'block', viewport:{width:1440,height:900}, ...options});
  ctx.setDefaultTimeout(6000);
  await ctx.route('**/*',r=>{
    if (new URL(r.request().url()).origin===origin) return r.continue();
    report.offsite.push(r.request().url());return r.abort();
  });
  ctx.on('page', p=>p.on('pageerror',e=>report.errors.push(String(e))));
  return ctx;
}
const marks=500, soakMs=120_000;
async function mountFrame(page,count,fixed) {
    await page.goto(origin+'/density-host.html');
    // Test data and generator live in the parent only. No guest test API or modified modules.
    await page.evaluate(async ({count,marks,fixed})=>{
      const {fixtures,fixtureTime}=await import('./fixtures.js');
      const {project}=await import('./snapshot-adapter.js');
      const sample=project(fixtures.dense,{now:fixtureTime});
      const attempts=Array.from({length:count},(_,i)=>({...sample.attempts[i % 14],id:`density-${i}`,state:'running'}));
      const makeMark=i=>({id:`mark-${i}`,kind:'event',stage:'verify',title:`Synthetic mark ${i}`,
        at:new Date(fixtureTime+i*1000).toISOString(), state:'recorded', source:'density fixture'});
      const history=Array.from({length:marks},(_,i)=>makeMark(i));
      const iframe=document.createElement('iframe');iframe.title='Density fixture';
      const pair=crypto.randomUUID();
      const ready=new Promise(resolve=>addEventListener('message',function handshake(e){
        if(e.origin!==location.origin||e.source!==iframe.contentWindow||e.data?.type!=='orbit-hive-ready'||e.data.document!==pair)return;
        removeEventListener('message',handshake);resolve(e.ports[0]);
      }));
      iframe.src=`/index.html#orbit-hive-document=${pair}`;document.body.append(iframe);
      const port=await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('No synthetic parent handshake')),5000))]);
       window.fixtureStatus=value=>port.postMessage({type:'status',value});
       let anchor=null;
      window.tick=async t=>{
        const generatedAt=new Date(fixtureTime+t*1000).toISOString();
        const rows=attempts.map((a,i)=>({...a, at:generatedAt,
          state:t%2&&i===0?'working':'running', id:i===count-1?`rotating-${t}`:a.id}));
        if (t%2)rows.reverse();
        if (t&&!fixed) {history.shift();history.push(makeMark(marks+t-1));}
        port.postMessage({type:'status',value:'loading'});
        port.postMessage({type:'view',view:{...sample, generatedAt, attempts:rows,records:history.slice(-200),
          metrics:{...sample.metrics,active:count}, stations:sample.stations.map(s=>s.id==='build'?{...s,signal:`${count} in flight`}:s)}});
        port.postMessage({type:'status',value:'connected'});
        const doc=iframe.contentDocument, start=performance.now();
        while (!doc.querySelector(`[data-attempt="rotating-${t}"]`)) {
          if (performance.now()-start>4000) throw Error('Guest did not render offered frame '+t);
          await new Promise(requestAnimationFrame);
        }
        const world=doc.querySelector('#world'), svg=world.querySelector('svg'), current=world.querySelector('[data-attempt="density-0"]');
        anchor??=current;
        return {scene:world.querySelectorAll('*').length, elements:doc.querySelectorAll('*').length,
          attempts:world.querySelectorAll('[data-attempt]').length, stations:world.querySelectorAll('[data-station]').length,
          width:doc.documentElement.scrollWidth, viewport:iframe.contentWindow.innerWidth, height:doc.documentElement.scrollHeight,
          sceneWidth:svg.getBoundingClientRect().width, sceneHeight:svg.getBoundingClientRect().height,
          focusStable:current===anchor && current===doc.activeElement && current.getAttribute('aria-pressed')==='true' &&
            doc.querySelector('#inspect-title')?.textContent==='density-0',
          stateUpdated:current.getAttribute('aria-label').includes(`State ${t%2?'working':'running'}.`),
          animations:doc.getAnimations().length};
      };
    },{count,fixed,marks});
    const tick=t=>page.evaluate(t=>window.tick(t), t);await tick(0);
    return {tick,frame:page.frames().find(f=>f.parentFrame())};
}

// Traverse the real tab order; stop on a cycle rather than assuming today's
// inbox, release buttons or text register will always have the same length.
async function tabTo(page,frame,selector) {
  const visited=new Set();
  for (;;) {
    await page.keyboard.press('Tab');
    const {target,key}=await frame.evaluate(selector=>{
      const el=document.activeElement;
      return {target:el?.matches(selector),key:[...document.querySelectorAll('*')].indexOf(el)};
    },selector);
    if(target) return;
    assert.ok(!visited.has(key),`Keyboard cycle did not reach ${selector}`);visited.add(key);
  }
}

async function frameChecks() {
  const ctx=await context({reducedMotion:'reduce'});
  try {
    const page=await ctx.newPage(), {tick,frame}=await mountFrame(page,14,true);
    const board=frame.locator('#board');
    if(!await board.evaluate(el=>el.open)) await board.locator('summary').press('Enter');
    await board.locator('summary').focus();
    await tabTo(page,frame,'#stations [data-key="verify"]');await page.keyboard.press('Enter');
    const active=()=>frame.evaluate(()=>({id:document.activeElement.id,title:document.querySelector('#inspect-title')?.textContent,
      selected:document.querySelector('[data-station][aria-pressed="true"]')?.dataset.station}));
    const before=await active();await tick(1);const after=await active();
    check('Keyboard inspector heading remains focused on the selected verification station after accepted refresh',
      before.id==='inspect-title'&&after.id==='inspect-title'&&before.title===after.title&&after.selected==='verify',{before,after});
    await page.evaluate(()=>window.fixtureStatus('disconnected'));
    await frame.locator('#connection').filter({hasText:/disconnected|connection lost|offline/i}).waitFor();
    check('F: disconnected retains the last observed IDs with explicit historical status',
      /last|histor|disconnected/i.test(await frame.locator('#connection').innerText()) && await frame.locator('[data-attempt="density-0"]').count()===1,
      await frame.locator('#connection').innerText());
    await frame.locator('[data-attempt="density-0"]').press('Enter');
    check('F: disconnected inspection offers no live Rails navigation',!await frame.getByRole('button',{name:/Open Rails timeline/}).isEnabled());
    await page.screenshot({path:path.join(path.dirname(output),'journey-F-disconnected.png'),animations:'disabled'});
    await page.evaluate(()=>window.fixtureStatus('unauthorized'));
    await frame.locator('#connection').filter({hasText:/unauthorized/i}).waitFor();
    check('F: unauthorized clears prior metric, rendered attempt IDs and selection',
      await frame.locator('#flight').textContent()==='Unknown' && !await frame.locator('[data-attempt]').count() &&
      !/density-0|rotating-1/.test(await frame.locator('body').textContent()),await frame.locator('#connection').innerText());
    await page.screenshot({path:path.join(path.dirname(output),'journey-F-unauthorized.png'),animations:'disabled'});
  } finally {await ctx.close();}
}
async function soak(count,fixed) {
  const ctx=await context({reducedMotion:'reduce'});
  try {
    const page=await ctx.newPage(), cdp=await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');const {tick,frame}=await mountFrame(page,count,fixed);
    const selected=frame.locator('[data-attempt="density-0"]');await selected.focus();await page.keyboard.press('Enter');
    // Warm the actual paths before using a post-GC baseline (including control).
    for(let t=1;t<=12;t++) await tick(t);
    const tag=`${count}/${fixed?'fixed':'rolling'}`;
    const samples=[],counts=[],t0=performance.now(), req0=requests;
    const sample=async t=>{
      const heapBefore=await cdp.send('Runtime.getHeapUsage');
      await cdp.send('HeapProfiler.collectGarbage');
      const heapAfter=await cdp.send('Runtime.getHeapUsage');
      const m=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(v=>[v.name,v.value]));
      samples.push({seconds:(performance.now()-t0)/1000, refresh:t, beforeGC:heapBefore.usedSize, afterGC:heapAfter.usedSize,
        dom:await cdp.send('Memory.getDOMCounters'), layouts:m.LayoutCount, layoutSeconds:m.LayoutDuration,
        recalc:m.RecalcStyleCount, taskSeconds:m.TaskDuration});
    };
    await sample(0);
    let t=0;
    do {
      counts.push(await tick(13+t++));
      if(performance.now()-t0>=samples.length*15_000)await sample(t);
      await sleep(400);
    } while(performance.now()-t0<soakMs);
    await sample(t);
    const last=samples.at(-1), seconds=last.seconds;
    const observed={tag,count,fixed,retainedHistory:marks,deliveredHistory:200,samples,seconds,refreshes:t,afterGCChangeBytes:last.afterGC-samples[0].afterGC,
      sampleRangeBytes:summary(samples.map(s=>s.afterGC)),networkRequestsAfterWarmup:requests-req0,
      dimensions:Object.fromEntries(['scene','elements','width','height','sceneWidth','sceneHeight','attempts','stations','animations'].map(k=>[k,summary(counts.map(x=>x[k]))])),
      layoutCount:last.layouts-samples[0].layouts, layoutSeconds:last.layoutSeconds-samples[0].layoutSeconds,
      focusOrKeyFailures:counts.filter(s=>!s.focusStable||!s.stateUpdated).length};
    report.soaks.push(observed);
    check(`Soak ${tag}: measured duration and repeated refresh`,seconds>=120 && t>=120,{seconds,refreshes:t});
    check(`Soak ${tag}: scene element budget`,observed.dimensions.scene.max<=500,observed.dimensions.scene);
    check(`Soak ${tag}: keyed identity, selection and focus`,observed.focusOrKeyFailures===0,observed.focusOrKeyFailures);
    check(`Soak ${tag}: bounded geometry, DOM and no animation under reduce`,counts.every(s=>s.stations===8 && s.attempts===count && s.width<=s.viewport && !s.animations) &&
      ['scene','elements','height','sceneWidth','sceneHeight'].every(k=>observed.dimensions[k].max===observed.dimensions[k].min), observed.dimensions);
    check(`Soak ${tag}: no polling/static asset requests during refresh`,observed.networkRequestsAfterWarmup===0,observed.networkRequestsAfterWarmup);
    // The text register intentionally sends focus to its detail heading. Check a new
    // accepted read while the user is still there, separately from diagram focus.
    if(fixed){
      if(!await frame.locator('#board').evaluate(el=>el.open))await frame.locator('#board summary').press('Enter');
      await frame.locator('#stations [data-key="verify"]').press('Enter');
      const active=()=>frame.evaluate(()=>({tag:document.activeElement.tagName,id:document.activeElement.id,
        title:document.querySelector('#inspect-title').textContent,selected:document.querySelector('[data-station][aria-pressed="true"]')?.dataset.station}));
      const before=await active();await tick(13+t);const after=await active();
      check('Text-register selection: inspector focus survives an accepted refresh',before.id==='inspect-title' &&
        after.id==='inspect-title' && after.title===before.title && after.selected==='verify',{before,after});
    }
    console.log('END',tag,JSON.stringify({seconds,refreshes:t,scene:observed.dimensions.scene.max,afterGCChangeBytes:observed.afterGCChangeBytes}));
  } finally {await ctx.close();}
}

// AX snapshots come from Chromium, not DOM aria-label attribute reads. Match role/name
// plus the live backend DOM node to distinguish the diagram button from the HTML control.
async function axNodes(cdp,selector) {
  const {root}=await cdp.send('DOM.getDocument');
  const {nodeIds}=await cdp.send('DOM.querySelectorAll',{nodeId:root.nodeId,selector});
  const ids=await Promise.all(nodeIds.map(async nodeId=>(await cdp.send('DOM.describeNode',{nodeId})).node.backendNodeId));
  const {nodes}=await cdp.send('Accessibility.getFullAXTree');
  return ids.map(id=>nodes.find(n=>n.backendDOMNodeId===id && !n.ignored)).map(n=>n?{
    role:n.role?.value, name:n.name?.value||'', pressed:n.properties?.find(p=>p.name==='pressed')?.value?.value,
    focusable:n.properties?.find(p=>p.name==='focusable')?.value?.value}:null);
}
const norm = s=>String(s).toLowerCase().replace(/\s+/g,' ').trim();
const scenes=['Authorization','Dispatch','Build','Verify','Review','Integrate','Deploy','Receiver'];
const registers=['Authorization','Dispatch','Build','Verification','Review','Integration','Deployment','Owner / receiver'];
async function accessibility(mode,options) {
  const ctx=await context(options);
  try {
    const page=await ctx.newPage(),cdp=await ctx.newCDPSession(page);
    await page.goto(origin+'/index.html?demo=dense');await page.locator('#flight').filter({hasText:/^14$/}).waitFor();
    const fixture=await page.evaluate(async()=>{
      const {fixtures,fixtureTime}=await import('./fixtures.js'), {project}=await import('./snapshot-adapter.js');
      const {attempts,stations}=project(fixtures.dense,{now:fixtureTime});return {attempts,stations};
    });
    const board=page.locator('#board'), autoOpen=await board.evaluate(el=>el.open);
    if(!autoOpen) await page.locator('#board summary').press('Enter');
    if (mode==='contrast-reduced' || mode==='still-high') {
      await page.locator('#prefs').press('Enter');
      if(mode==='still-high') {
        await page.locator('#static').press('Space');
        check('Still transitions preference works independently of reduced motion',await page.locator('#static').isChecked() &&
          await page.locator('html').evaluate(el=>el.classList.contains('still') && !matchMedia('(prefers-reduced-motion: reduce)').matches));
      }
      await page.locator('#contrast').press('Space');
      check(`${mode}: high contrast responds to keyboard`,await page.locator('#contrast').isChecked() && await page.locator('html').evaluate(el=>el.classList.contains('high')));
      await page.locator('#prefs').press('Enter');
    }
    const geometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
      dpr:devicePixelRatio, reduced:matchMedia('(prefers-reduced-motion:reduce)').matches,
      forced:matchMedia('(forced-colors:active)').matches,boardWidth:document.querySelector('#stations').getBoundingClientRect().width,
      rowsFit:[...document.querySelectorAll('#stations button')].every(el=>el.clientWidth>0 && el.scrollWidth<=el.clientWidth+1 && el.getBoundingClientRect().right<=innerWidth+1)}));
    const evidence={mode,autoOpen,geometry};(report.accessibility??=[]).push(evidence);
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:path.join(path.dirname(output),`accessibility-${mode}.png`),animations:'disabled'});
    check(`${mode}: reflow and register bounds`,geometry.width===options.viewport.width && geometry.scrollWidth<=geometry.width && geometry.rowsFit &&
      (geometry.width>720||autoOpen) && (mode!=='contrast-reduced'||(geometry.forced&&geometry.reduced)),geometry);
    evidence.scene=await axNodes(cdp,'[data-station]');evidence.register=await axNodes(cdp,'#stations .st-row');
    const usable=n=>n?.role==='button' && n.focusable===true;
    const contains=(n,x)=>norm(n?.name).includes(norm(x));
    check(`${mode}: eight named, focusable AX stations with signal, depth and quality`,evidence.scene.length===8 && fixture.stations.every((s,i)=>{
      const n=evidence.scene[i];return usable(n) && [scenes[i],s.signal,`Queue depth ${s.depth??'unknown'}`,`Quality ${s.quality}`].every(x=>contains(n,x));
    }),evidence.scene);
    check(`${mode}: eight native register AX buttons name equivalent station + signal`,evidence.register.length===8 && fixture.stations.every((s,i)=>
      usable(evidence.register[i]) && contains(evidence.register[i],registers[i]) && contains(evidence.register[i],s.signal)),evidence.register);
    // Quality and numeric queue depth may require opening the row; don't claim equal wording in the summary.
    evidence.stationDetails=[];
    for (const [i,s] of fixture.stations.entries()) {
      await page.locator(`#stations [data-key="${s.id}"]`).press(i%2?'Space':'Enter');
      const h=page.locator('#inspect-title'), text=norm(await page.locator('#inspection-body').ariaSnapshot());
      const ok=await h.innerText()===registers[i] && await h.evaluate(el=>el===document.activeElement) &&
        text.includes(norm(s.signal)) && text.includes(`text: ${norm(s.quality)}`) &&
        new RegExp(`term: queue depth - definition: "?${s.depth??'unknown'}"?(?: |$)`).test(text);
      evidence.stationDetails.push({id:s.id,ok,ax:text});
    }
    check(`${mode}: register keyboard activation opens equivalent inspector text and places focus`,evidence.stationDetails.every(x=>x.ok));
    await page.locator('[data-nav="work"]').first().press('Enter');await page.locator('#scope').selectOption('attempt');
    evidence.attemptRows=await axNodes(cdp,'#rows .obj');
    check(`${mode}: work-register AX has an actionable text equivalent for each worker ID, route and state`,evidence.attemptRows.length===fixture.attempts.length && fixture.attempts.every(a=>
      evidence.attemptRows.some(n=>usable(n)&&[a.id,a.route,a.state].every(x=>contains(n,x)))));
    const rowId=fixture.attempts[0].id;
    await page.locator('#rows .obj').filter({hasText:rowId}).press('Space');
    check(`${mode}: attempt selection moves to matching inspector`,await page.locator('#inspect-title').innerText()===rowId &&
      await page.locator('#inspect-title').evaluate(n=>n===document.activeElement));
    if (geometry.width>720) {
      await page.getByRole('navigation',{name:'Work surfaces'}).getByRole('button',{name:'Factory floor',exact:true}).press('Enter');
      // Enter the map from the preceding inbox, without focusing an SVG directly.
      await page.locator('#refresh').focus();await tabTo(page,page,'#world [data-station="auth"]');
      await page.keyboard.press('ArrowRight');await page.keyboard.press('Space');
      const selection=await page.evaluate(()=>({active:document.activeElement?.dataset.station,pressed:document.activeElement?.getAttribute('aria-pressed'),
        announcement:document.querySelector('#announcement').textContent,live:document.querySelector('#announcement').getAttribute('aria-live'),
        outline:getComputedStyle(document.activeElement.querySelector('.hs-outline')||document.activeElement).stroke}));
      evidence.keyboard=selection;
       check(`${mode}: Tab / ArrowRight / Space selects Dispatch without focus loss`,selection.active==='dispatch' && selection.pressed==='true' && selection.live==='polite' && /dispatch/i.test(selection.announcement) && selection.outline!=='none',selection);
    }
  } finally {await ctx.close();}
}

async function timings() {
  const ctx=await context();
  try {
    const page=await ctx.newPage(),cdp=await ctx.newCDPSession(page);await cdp.send('Performance.enable');
    const overview=[], pointer=[],keyboard=[];
    const afterFrame=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(performance.now())))));
    for(let i=0;i<20;i++) {
      const t=performance.now();await page.goto(origin+'/index.html?demo=dense');
      await page.waitForFunction(()=>document.querySelector('#flight')?.textContent==='14' && document.querySelector('[data-attempt]'));
      await afterFrame();overview.push(performance.now()-t);
    }
    // Actual trusted events: capture input timestamp before guest handlers. Second rAF
    // samples after a rendering opportunity; excludes Playwright's pre-input auto-wait.
    await page.evaluate(()=>{for(const event of ['pointerdown','keydown'])document.addEventListener(event,e=>{if(e.isTrusted)window.inputAt=e.timeStamp;},true);});
    for(const [kind,values] of [['pointer',pointer],['keyboard',keyboard]]) for(let i=0;i<24;i++) {
      const id=i%2?'dispatch':'auth', target=page.locator(`[data-station="${id}"]`);
      if(kind==='pointer') await target.click();else await target.press('Enter');
      assert.equal(await page.locator('#inspect-title').innerText(),registers[i%2]);
      values.push(await afterFrame() - await page.evaluate(()=>window.inputAt));
    }
    // Measure isolated synchronous scene projection, not IPC, fetch or paint. Operate on
    // an attached fixture scene in the dedicated harness document, not a patched app.
    await page.goto(origin+'/density-host.html');
    const projection=await page.evaluate(async marks=>{
      const {createScene}=await import('./scene.js'),{fixtures,fixtureTime}=await import('./fixtures.js'),{project}=await import('./snapshot-adapter.js');
      const v=project(fixtures.dense,{now:fixtureTime});v.attempts=v.attempts.slice(0,14);
      v.records=Array.from({length:marks},(_,i)=>({id:`e-${i}`,kind:'event',stage:'verify',title:`Event ${i}`}));
      const scene=createScene(document.body), times=[];
      try {for(let n=0;n<120;n++){
        v.attempts.reverse();v.attempts[0].state=n%2?'running':'working';
        const t=performance.now();scene.update(v,{kind:'attempt',id:v.attempts[0].id});
        if(n>=20)times.push(performance.now()-t);
      }}finally{scene.destroy();}return times;
    },marks);
    await page.goto(origin+'/index.html?demo=dense');await page.locator('#flight').filter({hasText:/^14$/}).waitFor();await afterFrame();
    const task=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
    const t=performance.now(), req=requests, before=await task();await sleep(5000);const after=await task();
    report.idle={foreground:await page.evaluate(()=>document.visibilityState), seconds:(performance.now()-t)/1000,
      rendererTaskSeconds:after.TaskDuration-before.TaskDuration, layouts:after.LayoutCount-before.LayoutCount, staticRequests:requests-req};
    report.timings={method:'20 no-store dense demo navigations; 24 actual input-to-post-rendering-opportunity samples per mode; 100 warm synchronous createScene.update calls at 14 attempts, with 500 unused history records retained.',
      overview, pointer, keyboard, projection};
    for(const [name,vs,budget] of [['overview',overview,1500],['pointer',pointer,100],['keyboard',keyboard,100],['projection',projection,16]]){
      check(`${name} local p95 <=${budget} ms`,percentile(vs,.95)<=budget,summary(vs));
    }
    check('Idle document is visible and no server polling in observed 5s window',report.idle.foreground==='visible' && report.idle.staticRequests===0,report.idle);
  } finally {await ctx.close();}
}

try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,headless:true,args:['--disable-dev-shm-usage']});
  report.environment.browser=browser.version();
  await safe('fixture frame refresh, disconnect and authorization',frameChecks);
  await safe('latency',timings);
  for(const [mode,options] of [
    ['desktop',{viewport:{width:1440,height:900}}],
    ['zoom-200-equivalent',{viewport:{width:720,height:450},deviceScaleFactor:2}],
    ['mobile',{viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true}],
    ['contrast-reduced',{viewport:{width:1440,height:900},reducedMotion:'reduce',forcedColors:'active'}],
    ['still-high',{viewport:{width:1440,height:900},reducedMotion:'no-preference'}],
  ]) await safe(mode,()=>accessibility(mode,options));
  if(!fast)for(const [count,fixed] of [[14,false],[30,false],[30,true]]) await safe(`soak ${count} ${fixed?'fixed':'rolling'}`,()=>soak(count,fixed));
  check('No uncaught page exceptions or offsite requests',!report.errors.length && !report.offsite.length);
} finally {
  await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  report.finished=new Date().toISOString();report.pass=!report.exceptions.length && report.checks.every(c=>c.pass) && report.soaks.length===(fast?0:3);
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(report.pass?'PASS':'FAIL',output,report.checks.filter(c=>!c.pass).map(c=>c.name));
  if(!report.pass)process.exitCode=1;
}
