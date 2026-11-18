import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';

const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
const cfg=JSON.parse((await lines.next()).value);
const secrets=[cfg.owner,cfg.reader,cfg.upstream];
const hasPrivate=text=>secrets.some(s=>text.includes(s)) || ['PRIVATE-FIXTURE-OMIT','PRIVATE_TEST_MESSAGE'].some(s=>text.includes(s));
const endpoint='/api/rizzstack/hive/reports';
const {alias,outside,feature,releaseAt,queueDigest}=cfg.fixture;
async function control(command) {process.stdout.write(command+'\n');return (await lines.next()).value;}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,
  args:['--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  // Motion allowed: absence of a hydrate/replay pulse must not pass just
  // because the test browser globally disabled animations.
  const context=await browser.newContext({viewport:{width:1580,height:1080},reducedMotion:'no-preference'});
  const offsite=[];
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin===cfg.origin) return route.continue();
    offsite.push(true);return route.abort();
  });
  const id=randomUUID(), lookalike=randomUUID();
  const monitor=(id,url,frame)=>({id,name:'Hive fixture',diagonal:32,aspect:'16:9',height:0,distance:0,pitch:0,yaw:0,offset:0,fontSize:19,
    frame,layout:{type:'pane',pane:{id:randomUUID(),kind:'browser',url}}});
  const state={version:1,view:'windows',arc:14,selected:id,monitors:[
    monitor(id,cfg.entry+'#orbit-config=%7B%7D',{x:12,y:10,width:1100,height:900,z:2}),
    monitor(lookalike,'/apps/rizzstack-hive/index.html',{x:1210,y:20,width:320,height:500,z:1})]};
  await context.addInitScript(({state,workspace})=>{
    if(self===top) {
      localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id',workspace);localStorage.setItem('orbit.workspace.v1',JSON.stringify(state));
      window.seenHiveBroadcast=false;
      addEventListener('message',e=>{if(['view','reports','follow'].includes(e.data?.type)||e.data?.view?.attempts)window.seenHiveBroadcast=true;});
      // Record the owner's per-read authentication start, before variable
      // network/proxy latency. Deliberately do not retain request bodies/headers.
      window.readTimes=[];window.reportTransfers=0;
      // Count actual host sends even if the guest drops a packet after receipt,
      // or its old document is discarded during the final credential rotation.
      const send=MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage=function(data,...rest){const result=send.call(this,data,...rest);
        if(data?.type==='reports')window.reportTransfers++;return result;};
      const fetch0=window.fetch.bind(window);
      window.fetch=(input,init)=>{if(typeof input==='string' && ['/api/auth','/api/rizzstack/hive/reports'].includes(input))
        window.readTimes.push({path:input,at:performance.now(),sent:window.reportTransfers});const promise=fetch0(input,init);
        if(input==='/obs-snapshot/snapshot')promise.then(()=>window.initialSnapshotReady??=performance.now(),()=>{});
        if(input==='/api/rizzstack/hive/reports')promise.then(r=>{window.fixturePacket=r.clone().json().catch(()=>null);},()=>{});
        return promise;};
    } else if(location.pathname.startsWith('/apps/rizzstack-hive')) {
      window.seenHive=[];window.workerPulses=[];
      const animate=Element.prototype.animate;
      Element.prototype.animate=function(...args){if(this.closest('#world'))window.workerPulses.push(this.closest('[data-attempt]')?.dataset.attempt??'other');return animate.apply(this,args);};
      // Instrument this disposable guest's own port, including negative intents
      // the reviewed UI doesn't offer. No hooks exist in production code.
      window.MessageChannel=class extends MessageChannel {
        constructor(){super();window.fixturePort=this.port1;this.port1.addEventListener('message',({data})=>window.seenHive.push(data));}
      };
    }
  },{state,workspace:cfg.workspace});
  const page=await context.newPage();page.setDefaultTimeout(15_000);
  const requests=[];page.on('request',r=>requests.push(r));
  const count=prefix=>requests.filter(r=>new URL(r.url()).pathname.startsWith(prefix)).length;
  page.on('pageerror',e=>console.error('Browser exception:',e.name));
  await page.goto(cfg.origin);
  const actual=page.frameLocator(`iframe[src*="${cfg.entry}"]`), fake=page.frameLocator('iframe[src*="/apps/rizzstack-hive/index.html"]');
  const share=page.getByRole('button',{name:'Share read-only overview with this Hive pane'});
  const enroll=page.getByRole('button',{name:'Share enrolled evidence with this pane',exact:true});
  const noEnroll=async()=>assert.ok(!(await enroll.isVisible())||await enroll.isDisabled(),'companion grant available without confirmed overview');
  await actual.locator('#connection').filter({hasText:/unauthorized/i}).waitFor();
  await fake.locator('#connection').filter({hasText:/unavailable/i}).waitFor();
  // Lazy static fixture/adapter modules must load in the real opaque frame,
  // including under its stricter CSP. Demo never requests a host grant.
  await actual.locator('#scenario').selectOption('shift');
  await actual.locator('#flight').filter({hasText:/^4$/}).waitFor();
  await actual.locator('#source-caption').filter({hasText:/synthetic/i}).waitFor();
  assert.equal(count('/obs-snapshot'),0);
  assert.equal(count(endpoint),0);await noEnroll();
  await actual.locator('#scenario').selectOption('host');
  await actual.locator('#connection').filter({hasText:/unauthorized/i}).waitFor();
  assert.equal(await actual.locator('#flight').textContent(),'Unknown');
  await page.getByRole('button',{name:'Connect local host',exact:true}).click();
  await page.getByLabel('Host session token').fill('not-the-fixture-owner');await page.getByRole('button',{name:'Unlock local host',exact:true}).click();
  await page.getByText(/That token was not accepted/).waitFor();assert.equal(count('/obs-snapshot'),0);
  await page.getByLabel('Host session token').fill(cfg.owner);await page.getByRole('button',{name:'Unlock local host',exact:true}).click();
  await share.waitFor();assert.equal(await share.count(),1);
  const child=page.frames().find(f=>f.url().includes(cfg.entry));
  assert.equal(await child.evaluate(()=>self.origin),'null');
  assert.equal(await child.evaluate(()=>{try{return !!parent.document;}catch{return false;}}),false);
  assert.equal(await child.evaluate(()=>{try{return !!localStorage;}catch{return false;}}),false);
  await actual.locator('#refresh').click();assert.equal(count('/obs-snapshot'),0);
  await noEnroll();assert.equal(count(endpoint),0);
  const firstRead=page.waitForRequest('**/obs-snapshot/snapshot');
  await page.evaluate(()=>{window.readTimes.length=0;});
  await share.click();
  await firstRead;await noEnroll();assert.equal(count(endpoint),0);
  await actual.locator('#flight').filter({hasText:/^4$/}).waitFor();
  const snap=requests.filter(r=>new URL(r.url()).pathname.startsWith('/obs-snapshot'));
  assert.equal(snap.length,1);assert.equal(new URL(snap[0].url()).pathname,'/obs-snapshot/snapshot');
  assert.equal(snap[0].method(),'GET');assert.equal(snap[0].frame(),page.mainFrame());assert.ok(!snap[0].headers().authorization);
  assert.equal(count('/api/rizzstack/rails/'),0);
  assert.deepEqual(await child.evaluate(()=>window.workerPulses),[]);
  async function capture(target,name) {
    if(!cfg.capture)return;
    assert.equal(await page.locator('input[type=password]:visible').count(),0);
    assert.ok(!hasPrivate(await target.innerText()));
    for(const f of page.frames().filter(f=>f.parentFrame())) assert.ok(!hasPrivate(await f.content()));
    await mkdir(cfg.capture,{recursive:true});
    await target.screenshot({path:path.join(cfg.capture,name+'.png'),animations:'disabled'});
  }
  await capture(page.locator(`[data-monitor-id="${id}"]`).filter({has:page.locator(`iframe[src*="${cfg.entry}"]`)}).last(),'opaque-overview');
  await child.evaluate(()=>{
    for(const intent of [{type:'rails',kind:'campaign',id:'att-fixture'},{type:'rails',kind:'attempt',id:'not-in-view'},
      {type:'rails',kind:'attempt',id:'att-fixture',url:'/api/auth'},{type:'execute',kind:'deploy',id:'att-fixture'},
      {type:'reports'},{type:'request',url:'/api/rizzstack/hive/reports'}])window.fixturePort.postMessage(intent);
  });
  const dialog=page.getByRole('dialog',{name:'Rizzstack Rails'});
  await actual.getByRole('button',{name:'Work register',exact:true}).click();
  assert.equal(await dialog.count(),0);assert.equal(count('/obs-snapshot'),1);
  assert.equal(count(endpoint),0);assert.equal(await child.evaluate(()=>window.seenHive.filter(m=>m.type==='reports').length),0);
  const beforeGrant=await child.evaluate(()=>JSON.stringify(window.seenHive));
  assert.ok([alias,outside,queueDigest,releaseAt].every(value=>!beforeGrant.includes(value)));
  async function excludes(frame,values){const html=await frame.content();assert.ok(values.every(s=>!html.includes(s)),'withheld evidence in document');}
  await excludes(child,[alias,outside,queueDigest,releaseAt]);
  await actual.locator('#evidence-state').filter({hasText:/not shared/i}).waitFor();
  // The actual owner route resolves all three enrolled files. Only two public
  // reports and a title from the current view may cross the document's port.
  const reportRead=page.waitForResponse(r=>new URL(r.url()).pathname===endpoint);
  assert.equal(await enroll.count(),1);await enroll.click();
  const resp=await reportRead, req=resp.request();
  assert.equal(resp.status(),200);assert.equal(req.url(),cfg.origin+endpoint);assert.equal(req.method(),'GET');
  assert.equal(req.frame(),page.mainFrame());assert.equal(req.postData(),null);
  assert.ok(req.headers().authorization==='Bearer '+cfg.owner);
  await page.waitForFunction(()=>!!window.fixturePacket);
  const packet=await page.evaluate(()=>window.fixturePacket);assert.deepEqual(Object.keys(packet).sort(),['labels','queue','release','version']);
  assert.equal(packet.version,'hive.reports/1');assert.equal(packet.queue?.queue.sha256,queueDigest);
  assert.equal(packet.release?.observedAt,releaseAt);assert.ok(JSON.stringify(packet.labels).includes(outside));
  await actual.locator('#evidence-state').filter({hasText:/enrolled evidence shared/i}).waitFor();
  const reports=await child.evaluate(()=>window.seenHive.find(m=>m.type==='reports'));
  assert.ok(!hasPrivate(JSON.stringify(reports)));
  assert.deepEqual(Object.keys(reports).sort(),['generatedAt','queue','release','titles','type']);
  assert.ok(JSON.stringify(reports.queue)===JSON.stringify(packet.queue) && JSON.stringify(reports.release)===JSON.stringify(packet.release));
  assert.deepEqual(reports.titles,[{kind:'job',id:'job:job-fixture',title:alias}]);
  assert.ok(!JSON.stringify(reports).includes(outside));await excludes(child,[outside]);
  await actual.locator('#scope').selectOption('job');await actual.locator('#rows .obj').filter({hasText:alias}).waitFor();
  await actual.locator('#scope').selectOption('queue');
  await actual.locator('#queue-evidence').getByText(feature,{exact:false}).first().waitFor();
  assert.match(await actual.locator('#queue-evidence').innerText(),/PARTIAL/);
  assert.match(await actual.locator('#queue-evidence').innerText(),/2 of 3/);
  await capture(actual.locator('#queue-evidence'),'report-queue');
  await actual.getByRole('button',{name:'Release desk',exact:true}).click();
  await actual.locator('#report-release').getByText(/workflow #91/i).first().waitFor();
  await actual.locator('#report-release').getByText(/runtime parity.*unknown/i).waitFor();
  await capture(actual.locator('#report-release'),'report-release');
  await actual.getByRole('button',{name:'Work register',exact:true}).click();
  // Both attempt and job selectors originate in the current projected view.
  await actual.locator('#scope').selectOption('job');await actual.locator('#search').fill('job-fixture');
  await actual.locator('#rows .obj').first().click();
  await actual.getByRole('button',{name:/Open Rails timeline/}).click();
  assert.equal(await dialog.getByLabel('Selector kind').inputValue(),'job');assert.equal(await dialog.getByLabel('Public selector ID').inputValue(),'job-fixture');
  await dialog.getByRole('button',{name:'Close Rails'}).click();
  await actual.getByRole('button',{name:'Work register',exact:true}).click();await actual.locator('#scope').selectOption('attempt');await actual.locator('#search').fill('att-fixture');
  await actual.locator('#rows .obj').filter({hasText:'att-fixture'}).click();
  const open=actual.getByRole('button',{name:/Open Rails timeline/});await open.click();
  assert.equal(await dialog.getByLabel('Selector kind').inputValue(),'attempt');assert.equal(await dialog.getByLabel('Public selector ID').inputValue(),'att-fixture');
  assert.equal(count('/api/rizzstack/rails/'),0);
  await actual.locator('#follow-state').filter({hasText:/off/i}).waitFor();
  await dialog.getByRole('button',{name:'Inspect history'}).click();
  const renderer=page.frameLocator('iframe[title="Read-only Rails timeline"]');
  await renderer.locator(`.rail-mark[data-event-id="${cfg.event}"]`).click();
  await dialog.getByText(/authority: worker_report/).waitFor();await renderer.locator('#rails-inspector').getByText(cfg.event,{exact:true}).first().waitFor();
  await capture(dialog,'selected-rails-origin-mark');
  assert.ok(await dialog.getByRole('button',{name:/Retry unavailable/}).isDisabled());
  await dialog.getByText(/Connected to updates/).waitFor();
  await actual.locator('#follow-state').filter({hasText:/stream live.*att-fixture/i}).waitFor();
  const streams=requests.filter(r=>new URL(r.url()).pathname==='/api/rizzstack/rails/stream');
  assert.equal(streams.length,1);const stream=streams[0];assert.equal(stream.frame(),page.mainFrame());
  assert.equal(stream.method(),'GET');assert.deepEqual(Object.fromEntries(new URL(stream.url()).searchParams),{kind:'attempt',id:'att-fixture'});
  const appended=await control('append');assert.notEqual(appended,cfg.event);
  await renderer.locator(`.rail-mark[data-event-id="${appended}"]`).waitFor();
  await actual.locator('#follow-state').filter({hasText:/history changed.*att-fixture/i}).waitFor();
  assert.equal(await actual.locator('#flight').textContent(),'4','a history notice is not a new fleet reading');
  assert.equal((await child.evaluate(()=>window.workerPulses)).length,0,'initial and SSE-only observations must not animate');
  assert.equal(await control('advance'),'advanced');
  await dialog.getByRole('button',{name:'Close Rails'}).click();
  await child.waitForFunction(()=>document.activeElement?.textContent?.includes('Open Rails timeline'));
  assert.ok((await actual.locator('#inspection-body').innerText()).includes('att-fixture'));
  await actual.locator('#follow-state').filter({hasText:/off/i}).waitFor();
  await actual.locator('#flight').filter({hasText:/^3$/}).waitFor({timeout:45_000});
  // Establish causality, not just eventual consistency during a normal poll:
  // the selected event woke the one scheduler before the original first
  // completion + 30s deadline. No refresh intent since the initial grant.
  assert.ok(await page.evaluate(()=>window.readTimes.filter(r=>r.path==='/api/auth')[1].at < window.initialSnapshotReady+30_000));
  await actual.locator('[data-attempt="att-fixture"][data-posture="filed"]').waitFor();
  await capture(actual.locator('#stream-ticket'),'report-selected-history-notice');
  const samples=await child.evaluate(()=>window.seenHive.filter(m=>m.type==='view').map(m=>m.view.generatedAt));
  assert.ok(samples.length>=2 && samples.at(-1)>samples[0]);
  // Leave the new snapshot unchanged for another real production polling
  // interval. The duplicate must not replay the changed attempt animation.
  const pulses=await child.evaluate(()=>window.workerPulses.slice());
  assert.ok(pulses.length<=1 && pulses.every(id=>id==='att-fixture'));
  const beforeBurst=count('/obs-snapshot');
  await child.evaluate(()=>{for(let i=0;i<12;i++)window.fixturePort.postMessage({type:'refresh'});});
  assert.equal(count('/obs-snapshot'),beforeBurst);
  await child.waitForFunction(at=>window.seenHive.filter(m=>m.type==='view'&&m.view.generatedAt===at).length>=2,samples.at(-1),{timeout:45_000});
  await child.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.deepEqual(await child.evaluate(()=>window.workerPulses),pulses);
  const recording=await child.evaluate(()=>JSON.stringify(window.seenHive));
  assert.ok(!hasPrivate(recording));assert.ok(!recording.includes('"fleet":') && !recording.includes('"pipeline":'));
  assert.ok(![outside,cfg.event,appended,'hive.public-labels/1'].some(s=>recording.includes(s)));
  assert.equal(await page.evaluate(()=>window.seenHiveBroadcast),false);
  assert.equal(await child.evaluate(async()=>{try {await fetch('/obs-snapshot/snapshot');return 'allowed';} catch {return 'refused';}}),'refused');
  // Use an actual previously accepted collector response after a newer one
  // and its duplicate. Don't inject requests, alter the pane or fake its ACK.
  // A report retry for the *accepted duplicate* can legitimately run before
  // the stale poll, so observe the boundary at the next owner re-auth start.
  const authBeforeOld=await page.evaluate(()=>window.readTimes.filter(r=>r.path==='/api/auth').length);
  const oldAuth=page.waitForRequest(r=>r.frame()===page.mainFrame()&&new URL(r.url()).pathname==='/api/auth',{timeout:45_000});
  const oldResponse=page.waitForResponse(r=>r.request().frame()===page.mainFrame()&&new URL(r.url()).pathname==='/obs-snapshot/snapshot',{timeout:45_000});
  assert.equal(await control('replay-old'),'replaying');assert.equal((await oldResponse).status(),200);
  await actual.locator('#connection').filter({hasText:/out of order/i}).waitFor();
  const fromOldPoll=await page.evaluate(n=>window.readTimes.filter(r=>r.path==='/api/auth')[n],authBeforeOld);
  const requestBoundary=requests.indexOf(await oldAuth);assert.ok(requestBoundary>=0);
  assert.ok(fromOldPoll && fromOldPoll.sent>0,'the stale read must follow a successful evidence grant and transfer');
  async function noRejectedEvidence(){
    assert.ok(!requests.slice(requestBoundary).some(r=>new URL(r.url()).pathname===endpoint),'report request after stale poll began');
    const blocked=await page.evaluate(({at,sent})=>({
      gets:window.readTimes.filter(r=>r.path==='/api/rizzstack/hive/reports' && r.at>=at).length,
      sends:window.reportTransfers-sent,
    }),fromOldPoll);
    assert.deepEqual(blocked,{gets:0,sends:0},'rejected overview must neither fetch nor transfer reports');
  }
  await noRejectedEvidence();
  const evidenceButton=page.getByRole('button',{name:/^(Share enrolled evidence with this pane|Stop sharing overview and evidence)$/});
  assert.ok(!(await evidenceButton.isVisible())||await evidenceButton.isDisabled(),'evidence control must not use the rejected view');
  assert.equal(await child.evaluate(()=>window.seenHive.filter(m=>m.type==='reports').length),fromOldPoll.sent);
  await excludes(child,[alias,outside,queueDigest,releaseAt]);
  // The same document's freshness boundary survives a fresh grant, while
  // its private rows and report consent do not. The collector still serves
  // the formerly accepted older observation.
  const offersBefore=await child.evaluate(()=>window.seenHive.filter(m=>m.type==='admission').length);
  await actual.locator('#scenario').selectOption('shift');
  await actual.locator('#source-caption').filter({hasText:/synthetic/i}).waitFor();
  await actual.locator('#scenario').selectOption('host');await share.waitFor();
  const resumedRead=page.waitForResponse(r=>new URL(r.url()).pathname==='/obs-snapshot/snapshot',{timeout:45_000});
  await share.click();assert.equal((await resumedRead).status(),200);
  await actual.locator('#connection').filter({hasText:/out of order/i}).waitFor();
  assert.equal(child.isDetached(),false);assert.equal(await child.evaluate(()=>window.seenHive.filter(m=>m.type==='admission').length),offersBefore);
  await noEnroll();await noRejectedEvidence();await excludes(child,[alias,outside,queueDigest,releaseAt]);
  // Revocation is an actual collector bearer rejection through Orbit. Give the
  // initial 30-second floor time to elapse (not a shortened production timer).
  const refusal=page.waitForResponse(r=>new URL(r.url()).pathname==='/obs-snapshot/snapshot'&&[401,403].includes(r.status()),{timeout:45_000});
  assert.equal(await control('revoke'),'revoked');await refusal;
  await actual.locator('#connection').filter({hasText:/unauthorized/i}).waitFor({timeout:45_000});
  assert.equal(await actual.locator('#flight').textContent(),'Unknown');assert.ok(!(await actual.locator('body').innerText()).includes('att-fixture'));
  assert.ok(!(await fake.locator('body').innerText()).includes('att-fixture'));
  // A subsequent opaque document shares the WindowProxy, not the granted port.
  assert.ok(child.isDetached(),'revocation discards the old document and hidden/ARIA content');
  await noRejectedEvidence(); // Includes the entire real cadence until the bearer refusal.
  const fresh=page.frames().find(f=>f.url().includes(cfg.entry));
  await noEnroll();await excludes(fresh,[alias,outside,feature,queueDigest,releaseAt,'att-fixture']);
  await excludes(page.frames().find(f=>new URL(f.url()).pathname==='/apps/rizzstack-hive/index.html'),[alias,outside,feature,queueDigest,releaseAt]);
  assert.equal(await fresh.evaluate(()=>window.seenHive.some(m=>m.type==='reports')),false);
  await fresh.evaluate(()=>location.replace('/apps/rizzstack-hive/index.html'+location.hash));await share.waitFor({state:'detached'});
  for (const f of page.frames().filter(f=>f.parentFrame())) assert.ok(!hasPrivate(f.url()+(await f.content())));
  assert.ok(!hasPrivate(await page.evaluate(()=>JSON.stringify(localStorage))));
  for (const r of requests) {
    assert.ok(!hasPrivate(r.url()));
    const headers=JSON.stringify(r.headers());assert.ok(!headers.includes(cfg.reader) && !headers.includes(cfg.upstream));
    if(r.frame().parentFrame()) assert.ok(!hasPrivate(headers+(r.postData()||'')));
  }
  assert.equal(offsite.length,0);
  const times=await page.evaluate(()=>window.readTimes);
  for(const p of ['/api/auth',endpoint]){
    const t=times.filter(r=>r.path===p).map(r=>r.at);
    assert.ok(t.length>=(p===endpoint?1:5));
    // Host sets the cadence clock immediately before calling fetch. Two
    // timestamp reads can straddle adjacent high-resolution clock ticks.
    assert.ok(t.slice(1).every((at,i)=>at-t[i]>=30_000-1),'host read starts violate the 30-second floor');
  }
} finally {await browser.close();process.stdin.destroy();}
