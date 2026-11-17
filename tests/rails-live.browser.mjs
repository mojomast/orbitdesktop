import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';

const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
const cfg=JSON.parse((await lines.next()).value);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,headless:true,
  args:['--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===cfg.origin?route.continue():route.abort());
  const url='/apps/rizzstack-observatory/index.html#orbit-config='+encodeURIComponent(JSON.stringify({snapshot_url:'./snapshot.json'}));
  const monitor=randomUUID(),state={version:1,selected:monitor,arc:14,view:'windows',monitors:[{id:monitor,name:'Observatory',diagonal:32,aspect:'16:9',height:0,distance:0,pitch:0,yaw:0,offset:0,fontSize:19,frame:{x:15,y:15,width:1000,height:700,z:1},layout:{type:'pane',pane:{id:randomUUID(),kind:'browser',url}}}]};
  await context.addInitScript(({state,id})=>{if(window.top===window){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id',id);localStorage.setItem('orbit.workspace.v1',JSON.stringify(state));}}, {state,id:cfg.workspace});
  const page=await context.newPage(); page.setDefaultTimeout(10000);
  const requests=[];page.on('request',request=>requests.push(request));
  const railStatus=[];page.on('response',r=>{const path=new URL(r.url()).pathname;if(path.startsWith('/api/rizzstack/rails/'))railStatus.push(path.split('/').at(-1)+':'+r.status());});
  page.on('pageerror',error=>console.error(error.name));
  await page.goto(cfg.origin);
  const obs=page.frameLocator('iframe[title="Embedded browser"]');
  const row=obs.getByRole('button',{name:'Inspect Rails for attempt att-fixture'});
  assert.ok(await obs.getByRole('button',{name:'Rails unavailable'}).isDisabled());
  await row.click();const dialog=page.getByRole('dialog',{name:'Rizzstack Rails'});
  await dialog.getByText(/Unauthorized/).waitFor();
  assert.equal(requests.filter(r=>r.url().includes('/api/rizzstack/')).length,0);
  await dialog.getByRole('button',{name:'Close Rails'}).click();
  await page.getByRole('button',{name:'Connect local host',exact:true}).click();
  await page.getByLabel('Host session token').fill(cfg.owner);
  await page.getByRole('button',{name:'Unlock local host',exact:true}).click();
  await row.click();await dialog.getByRole('button',{name:'Inspect history'}).click();
  const renderer=page.frameLocator('iframe[title="Read-only Rails timeline"]');
  const mark=renderer.locator(`.rail-mark[data-event-id="${cfg.event}"]`);
  await mark.click();await renderer.locator('#rails-inspector').getByText(cfg.event,{exact:true}).first().waitFor();
  await dialog.getByText(/authority: worker_report/).waitFor();
  assert.ok(await dialog.getByRole('button',{name:/Retry unavailable/}).isDisabled());
  await dialog.getByRole('button',{name:'Preview feedback'}).click();await dialog.getByLabel('Optional quality note').fill('private synthetic fixture note');
  await dialog.getByRole('button',{name:'Review sanitized draft'}).click();await dialog.getByText(/note: \[redacted\]. Draft only/).waitFor();
  await dialog.getByRole('button',{name:'Prepare signed feedback'}).click();
  if(cfg.signed){
    const exact=await dialog.locator('pre').textContent();assert.equal(JSON.parse(exact).workspace_id,cfg.workspace);assert.ok(!exact.includes('private synthetic'));
    process.stdout.write('sign '+JSON.stringify(exact)+'\n');const signature=JSON.parse((await lines.next()).value);
    await dialog.getByLabel('Detached SSH signature').fill(signature);await dialog.getByRole('button',{name:'Confirm signed feedback'}).click();
    await dialog.getByText(/Outcome unknown/).waitFor();await dialog.getByRole('button',{name:'Confirm signed feedback'}).click();
    await dialog.getByText(/Feedback recorded:.*original receipt/).waitFor().catch(async()=>{
      throw Error(`Receipt not displayed: ${railStatus.join(',')}; confirm controls: ${await dialog.getByLabel('Detached SSH signature').count()}; ${await dialog.locator('[role=status]').innerText()}`);
    });
  }else await dialog.getByText(/No enrolled feedback writer available/).waitFor();
  // No pane has access to the parent DOM/storage or owner headers.
  for(const f of page.frames().filter(f=>f.parentFrame())) {
    assert.equal(await f.evaluate(()=>{try{return !!parent.document;}catch{return false;}}),false);
    const content=await f.content();assert.ok(!content.includes(cfg.owner)&&!content.includes(cfg.reader));
  }
  const pane=page.frames().find(f=>f.url().includes('/apps/rizzstack-observatory/'));
  assert.equal(await pane.evaluate(async()=>{try{await fetch('/api/rizzstack/rails/feedback',{method:'POST',body:'{}'});return 'accepted';}catch{return 'refused';}}),'refused');
  await dialog.getByText(/Connected to updates/).waitFor().catch(()=>{throw Error(`Stream did not connect: ${railStatus.slice(-18).join(',')}`);});process.stdout.write('append\n');
  const next=(await lines.next()).value;
  await renderer.locator(`.rail-mark[data-event-id="${next}"]`).waitFor();
  process.stdout.write('restart\n');const resumed=(await lines.next()).value;
  await renderer.locator(`.rail-mark[data-event-id="${resumed}"]`).waitFor();assert.equal(await renderer.locator('.rail-mark').count(),cfg.signed?4:3);
  process.stdout.write('revoke\n');await dialog.getByText(/Unauthorized/).waitFor();assert.equal(await renderer.locator('.rail-mark').count(),0);
  await dialog.getByRole('button',{name:'Close Rails'}).click();await row.evaluate(el=>new Promise((resolve,reject)=>{let n=0;function check(){if(el===document.activeElement)return resolve(true);if(++n>60)return reject(Error('row focus was not restored'));requestAnimationFrame(check);}check();}));
  for(const req of requests){const external=Object.values(req.headers()).join(' ');assert.ok(!req.url().includes(cfg.owner)&&!req.url().includes(cfg.reader)&&!external.includes(cfg.reader));
    if(req.frame().parentFrame())assert.ok(!external.includes(cfg.owner));}
} finally {await browser.close();process.stdin.destroy();}
