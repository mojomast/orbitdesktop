import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';

const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
const cfg=JSON.parse((await lines.next()).value);
const secrets=[cfg.owner,cfg.reader,cfg.upstream];
const hasPrivate=text=>secrets.some(s=>text.includes(s)) || text.includes('PRIVATE-FIXTURE-OMIT');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,
  args:['--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const context=await browser.newContext({viewport:{width:1580,height:1080},reducedMotion:'reduce'});
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
      addEventListener('message',e=>{if(e.data?.type==='view'||e.data?.view?.attempts)window.seenHiveBroadcast=true;});
    } else if(location.pathname.startsWith('/apps/rizzstack-hive')) {
      window.seenHive=[];
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
  await actual.locator('#connection').filter({hasText:/unauthorized/i}).waitFor();
  await fake.locator('#connection').filter({hasText:/unavailable/i}).waitFor();
  // Lazy static fixture/adapter modules must load in the real opaque frame,
  // including under its stricter CSP. Demo never requests a host grant.
  await actual.locator('#scenario').selectOption('shift');
  await actual.locator('#flight').filter({hasText:/^4$/}).waitFor();
  await actual.locator('#source-caption').filter({hasText:/synthetic/i}).waitFor();
  assert.equal(count('/obs-snapshot'),0);
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
  await share.click();
  await actual.locator('#flight').filter({hasText:/^4$/}).waitFor();
  const snap=requests.filter(r=>new URL(r.url()).pathname.startsWith('/obs-snapshot'));
  assert.equal(snap.length,1);assert.equal(new URL(snap[0].url()).pathname,'/obs-snapshot/snapshot');
  assert.equal(snap[0].method(),'GET');assert.equal(snap[0].frame(),page.mainFrame());assert.ok(!snap[0].headers().authorization);
  assert.equal(count('/api/rizzstack/rails/'),0);
  async function capture(target,name) {
    if(!cfg.capture)return;
    assert.equal(await page.locator('input[type=password]:visible').count(),0);
    assert.ok(!hasPrivate(await target.innerText()));
    await mkdir(cfg.capture,{recursive:true});
    await target.screenshot({path:path.join(cfg.capture,name+'.png'),animations:'disabled'});
  }
  await capture(page.locator(`[data-monitor-id="${id}"]`).filter({has:page.locator(`iframe[src*="${cfg.entry}"]`)}).last(),'opaque-overview');
  await child.evaluate(()=>{
    for(const intent of [{type:'rails',kind:'campaign',id:'att-fixture'},{type:'rails',kind:'attempt',id:'not-in-view'},
      {type:'rails',kind:'attempt',id:'att-fixture',url:'/api/auth'},{type:'execute',kind:'deploy',id:'att-fixture'}])window.fixturePort.postMessage(intent);
    for(let i=0;i<12;i++)window.fixturePort.postMessage({type:'refresh'});
  });
  const dialog=page.getByRole('dialog',{name:'Rizzstack Rails'});
  await actual.getByRole('button',{name:'Work register',exact:true}).click();
  assert.equal(await dialog.count(),0);assert.equal(count('/obs-snapshot'),1);
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
  await dialog.getByRole('button',{name:'Inspect history'}).click();
  const renderer=page.frameLocator('iframe[title="Read-only Rails timeline"]');
  await renderer.locator(`.rail-mark[data-event-id="${cfg.event}"]`).click();
  await dialog.getByText(/authority: worker_report/).waitFor();await renderer.locator('#rails-inspector').getByText(cfg.event,{exact:true}).first().waitFor();
  await capture(dialog,'selected-rails-origin-mark');
  assert.ok(await dialog.getByRole('button',{name:/Retry unavailable/}).isDisabled());
  await dialog.getByRole('button',{name:'Close Rails'}).click();
  await child.waitForFunction(()=>document.activeElement?.textContent?.includes('Open Rails timeline'));
  assert.ok((await actual.locator('#inspection-body').innerText()).includes('att-fixture'));
  const recording=await child.evaluate(()=>JSON.stringify(window.seenHive));
  assert.ok(!hasPrivate(recording));assert.ok(!recording.includes('"fleet":') && !recording.includes('"pipeline":'));
  assert.equal(await page.evaluate(()=>window.seenHiveBroadcast),false);
  assert.equal(await child.evaluate(async()=>{try {await fetch('/obs-snapshot/snapshot');return 'allowed';} catch {return 'refused';}}),'refused');
  // Revocation is an actual collector bearer rejection through Orbit. Give the
  // initial 30-second floor time to elapse (not a shortened production timer).
  process.stdout.write('revoke\n');assert.equal((await lines.next()).value,'revoked');
  await actual.locator('#connection').filter({hasText:/unauthorized/i}).waitFor({timeout:45_000});
  assert.equal(await actual.locator('#flight').textContent(),'Unknown');assert.ok(!(await actual.locator('body').innerText()).includes('att-fixture'));
  assert.ok(!(await fake.locator('body').innerText()).includes('att-fixture'));
  // A subsequent opaque document shares the WindowProxy, not the granted port.
  assert.ok(child.isDetached(),'revocation discards the old document and hidden/ARIA content');
  const fresh=page.frames().find(f=>f.url().includes(cfg.entry));
  await fresh.evaluate(()=>location.replace('/apps/rizzstack-hive/index.html'+location.hash));await share.waitFor({state:'detached'});
  for (const f of page.frames().filter(f=>f.parentFrame())) assert.ok(!hasPrivate(f.url()+(await f.content())));
  assert.ok(!hasPrivate(await page.evaluate(()=>JSON.stringify(localStorage))));
  for (const r of requests) {
    assert.ok(!hasPrivate(r.url()));
    const headers=JSON.stringify(r.headers());assert.ok(!headers.includes(cfg.reader) && !headers.includes(cfg.upstream));
    if(r.frame().parentFrame()) assert.ok(!hasPrivate(headers+(r.postData()||'')));
  }
  assert.equal(offsite.length,0);
} finally {await browser.close();process.stdin.destroy();}
