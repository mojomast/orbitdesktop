import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright-core';

const root=fs.mkdtempSync('/tmp/opencode/reliability-browser-'),log=fs.openSync(path.join(root,'server.log'),'w');
const child=spawn(process.execPath,['--experimental-strip-types','tests/workbench-reliability-browser-fixture.mjs',root],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:root},stdio:['ignore',log,log]});
let browser;
try{
  for(let n=0;!fs.existsSync(path.join(root,'ready.json'));n++){if(child.exitCode!==null||n>200)throw Error(fs.readFileSync(path.join(root,'server.log'),'utf8'));await new Promise(r=>setTimeout(r,100));}
  const config=JSON.parse(fs.readFileSync(path.join(root,'ready.json')));
  const executable=process.env.ORBIT_TEST_CHROMIUM??chromium.executablePath();
  browser=await chromium.launch({headless:true,executablePath:executable,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:980,height:1000}});let page=await context.newPage();const errors=[],requests=[];
  const observe=p=>{p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.url().includes('/api/workbench/'))requests.push(r.postDataJSON());});};observe(page);
  const fixture=async action=>{const response=await context.request.post(`${config.origin}/fixture`,{headers:{Authorization:`Bearer ${config.token}`,Origin:config.origin},data:{action}});assert.equal(response.status(),200);return response.json();};
  const button=(scope,text)=>scope.locator('button').filter({hasText:new RegExp(`^${text}$`)});
  const text=async(locator,expected)=>{await locator.filter({hasText:expected}).first().waitFor({state:'visible'});};
  await page.goto(config.origin);let setup=page.locator('.workbench-setup');
  await setup.getByLabel('Project for this task',{exact:true}).selectOption(config.project_id);
  await setup.getByLabel('What are we working on?',{exact:true}).fill('Browser waiting task');
  await button(setup,'Review setup').click();await button(setup,'Set up task').click();await button(setup,'Save for later review').waitFor({state:'visible'});
  // Lose the actual response after committing the wait. Reload retains the exact
  // operation envelope; explicit retry reads the receipt instead of duplicating.
  let dropped=false;
  await page.route('**/api/workbench/setup',async route=>{if(route.request().postDataJSON().action==='wait'&&!dropped){dropped=true;await route.fetch();await route.abort();}else await route.continue();});
  await button(setup,'Save for later review').click();await button(setup,'Retry exact request').waitFor({state:'visible'});
  await page.reload();setup=page.locator('.workbench-setup');await button(setup,'Retry exact request').click();await button(setup,'Retry exact request').waitFor({state:'hidden'});
  await button(setup,'Check saved state').click();await text(setup.locator('.workbench-setup-waiting'),'waiting lane');
  const waitRequests=requests.filter(r=>r.action==='wait');assert.equal(waitRequests.length,2);assert.deepEqual(waitRequests[0],waitRequests[1]);assert.equal((await fixture('inspect')).waits.length,1);
  await fixture('release');await button(setup,'Check saved state').click();await text(setup.locator('.workbench-setup-waiting'),'needs review');
  await button(setup,'Review waiting task').click();await text(setup.locator('.workbench-setup-review'),'Review before starting work');assert.equal((await fixture('inspect')).starts,0);
  await button(setup,'Check saved state').click();await text(setup.locator('.workbench-setup-waiting'),'reviewed');
  await button(setup,'Save for later review').click();await button(setup,'Cancel waiting intention').click();await text(setup.locator('.workbench-setup-waiting'),'cancelled');
  await button(setup,'Save for later review').click();await fixture('drift');await button(setup,'Check saved state').click();await text(setup.locator('.workbench-setup-waiting'),'setup source or policy changed');
  await button(setup,'Review waiting task').click();await text(setup.locator('[role=alert]'),'Project files or workspace policy changed');
  await fixture('expire');await button(setup,'Check saved state').click();await text(setup.locator('.workbench-setup-waiting'),'expired');
  await setup.locator('summary').filter({hasText:'Setup capacity'}).click();await text(setup,'slots remaining');
  // Simulate a disconnected owner returning after a persisted terminal receipt.
  await page.close();await fixture('complete');page=await context.newPage();observe(page);await page.goto(config.origin);
  const inbox=page.locator('.pane-workbench-inbox'),task=inbox.locator('article').filter({hasText:'Browser waiting task'});
  await text(task,'completed');await text(task,'required evidence incomplete');await text(task,'Result: available');assert.equal(await task.count(),1);
  await fixture('change_status');await button(task,'Mark status read').click();await text(inbox.locator('[role=status]'),'Task status changed');
  await button(inbox,'Refresh task inbox').click();await button(task,'Mark status read').click();await page.waitForFunction(()=>document.querySelector('.pane-workbench-inbox summary')?.textContent.includes('1 unread'));
  await page.reload();await text(task,'completed');assert.equal(await button(task,'Mark status read').isDisabled(),true);
  await button(task,'Open checks').click();await text(page.locator('#opened'),':checks');
  await inbox.locator('summary').filter({hasText:'Record capacity'}).click();await text(inbox,'slots remaining');
  // Tampering refuses recovery. An explicit exact retry after restoring bytes
  // settles one retained publication, without another check or integration call.
  const receipt=page.locator(`[data-integration-id="${config.integration_id}"]`);await text(receipt,'receipt_pending');await fixture('tamper');
  await button(receipt,'Finalize integration receipt').click();await text(page.locator('#workflow [role=status]'),'Finalization unconfirmed or refused');
  assert.equal((await fixture('inspect')).integrations[0].status,'receipt_pending');await fixture('repair');
  await button(receipt,'Finalize integration receipt').click();await text(page.locator('#workflow [role=status]'),'Historical receipt integrated');
  const final=await fixture('inspect');assert.equal(final.starts,0);assert.equal(final.previews,1);assert.equal(final.integrations.length,1);assert.equal(final.integrations[0].status,'integrated');
  const finalizations=requests.filter(r=>r.action==='integration_finalize_retry');assert.equal(finalizations.length,2);assert.deepEqual(finalizations[0],finalizations[1]);assert.equal(requests.filter(r=>r.action==='integrate_confirm'||r.action==='launch'||r.action==='check_run').length,0);
  await page.setViewportSize({width:420,height:900});
  const widths=await page.locator('.workbench-setup,.pane-workbench-inbox,.workbench-integration-receipts').evaluateAll(nodes=>nodes.map(node=>({name:node.className,client:node.clientWidth,scroll:node.scrollWidth})));
  assert.ok(widths.every(size=>size.scroll<=size.client+2),JSON.stringify(widths));
  assert.deepEqual(errors,[]);console.log('PASS: real-service browser recovery UI; lost wait reply/reload, quarantine/review/cancel/drift/expiry, reconnect inbox/stale/read, tampered publication/exact finalization, capacity, narrow viewport; zero worker starts.');
}catch(error){console.error(fs.readFileSync(path.join(root,'server.log'),'utf8'));throw error;}
finally{
  await browser?.close();if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}fs.closeSync(log);fs.rmSync(root,{recursive:true,force:true});
}
