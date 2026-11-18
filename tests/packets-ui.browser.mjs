// Run with Node 22 and a provisioned Chromium executable (CHROMIUM_PATH).
// Production host views, real owner routes on a temporary Orbit; the only
// substituted browser resources are a minimal host page and its local JS.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { initial } from '../src/model.ts';
import { boot } from './fixtures/local-orbit.mjs';
import { makeFixture, snapshot } from './fixtures/acdd-board.mjs';

test('owner edits repository review list and inspects verifier chips, feed and panel in Chromium', {timeout:60000}, async t => {
  const {root,ref} = makeFixture(t), before = snapshot(root);
  const pat = 'fixture-metadata-token-0123456789', seen=[];
  const fake = http.createServer((req,res) => {
    seen.push(req.url.split('?')[0]);
    assert.equal(req.headers.authorization,`Bearer ${pat}`);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url === '/user' ? {login:'fixture'} : [{full_name:'owner/review',description:'not-for-display',private:true}]));
  });
  await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>fake.close(resolve)));
  const app = await boot(t,{ORBIT_ACDD_STATE_DIR:root, ORBIT_GITHUB_API:`http://127.0.0.1:${fake.address().port}`,
    HERMES_API_URL:'http://127.0.0.1:9',HERMES_API_KEY:'synthetic-smoke-key'});
  const state=initial(), workspace_id=randomUUID();
  const pane=state.monitors[1].layout.pane; pane.url='orbit://surface/collab';
  assert.equal((await app.call('POST','/api/workspace',{action:'sync',state,workspace_id})).status,200);
  const identity={workspace_id,pane_id:pane.id, session_id:`orbit-collab-${pane.id}`,action:'collab'};
  const collab=async body=>{ const {status,data}=await app.call('POST','/api/agent',{...identity,...body}); assert.equal(status,200,JSON.stringify(data)); return data; };
  const {project:{id:project_id}}=await collab({operation:'create',board_only:true,title:'Fixture board',goal:'Review evidence.'});
  for (const [title,contract] of [['Pricing',ref],['Legacy',undefined],['Other revision',{...ref,contract_sha256:'f'.repeat(64)}]]) {
    await collab({operation:'board',board_action:'add',project_id,title,contract});
  }

  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH, args:['--no-sandbox','--disable-dev-shm-usage']});
  t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'}), page=await context.newPage();
  const errors=[], evidenceGets=[];
  page.on('pageerror',e=>errors.push(e.message)); page.setDefaultTimeout(8000);
  const {outputFiles}=await build({stdin:{contents:`export {openSetupSettings,openSetupWizard} from './src/first-run'; export {openAcddEvidence} from './src/acdd-evidence-window'; export {mountCollab} from './src/collab'`,resolveDir:process.cwd()},bundle:true,format:'iife',globalName:'hostViews',write:false,loader:{'.css':'empty'}});
  await context.route('**/*', route=>{
    const url=new URL(route.request().url());
    if (url.origin!==app.base) { errors.push('external request'); return route.abort(); }
    if (url.pathname==='/fixture') return route.fulfill({contentType:'text/html', headers:{'Referrer-Policy':'no-referrer'},body:'<!doctype html><title>Orbit fixture</title><script src="/fixture.js"></script>'});
    if (url.pathname==='/fixture.js') return route.fulfill({contentType:'text/javascript',body:outputFiles[0].text});
    if (url.pathname==='/api/acdd-evidence') evidenceGets.push(route.request().method());
    return route.continue();
  });
  await page.goto(app.base+'/fixture');
  await page.evaluate(token=>hostViews.openSetupSettings(()=>token), app.token);
  const password=page.getByLabel('GitHub token',{exact:true});
  await password.waitFor(); assert.equal(await password.getAttribute('type'),'password'); assert.deepEqual(seen,[]);
  await password.fill(pat); await page.getByRole('button',{name:'Connect with token'}).click();
  const list=page.getByRole('button',{name:'Choose from my GitHub repositories'}); await list.waitFor();
  assert.deepEqual(seen,['/user']); await list.click();
  await page.getByRole('button',{name:'Watch owner/review'}).click();
  await page.getByRole('button',{name:'Save repositories to watch'}).click();
  await page.getByText('Saved 1 repository for review.').waitFor();
  assert.equal((await app.call('GET','/api/settings/repos')).data.repos.join(','),'owner/review');
  assert.deepEqual(seen,['/user','/user/repos']);
  assert.doesNotMatch(await page.locator('body').innerText(),/not-for-display|fixture-metadata-token/);
  await page.getByRole('button',{name:'Disconnect GitHub'}).click(); await password.waitFor();
  assert.equal(fs.existsSync(path.join(app.runtime,'github','token')),false);
  await page.getByRole('button',{name:'Close Orbit settings'}).click();

  await page.evaluate(({identity,project_id,token})=>{
    sessionStorage.setItem('orbit.collab.focus',project_id);
    const view=hostViews.mountCollab({standalone:true,onClose(){},token:()=>token,request:async body=>{
      const r=await fetch('/api/agent',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...identity,...body})});
      if(!r.ok) throw Error('Fixture board read failed'); return r.json();
    }}); document.body.append(view.element);
  },{identity,project_id,token:app.token});
  const chip=page.locator('.collab-card').filter({hasText:'Pricing'}).getByText('ACDD · historical runs only');
  await chip.waitFor(); assert.equal(await chip.getAttribute('data-verifier'),'pending');
  assert.equal(await page.locator('.collab-card').filter({hasText:'Legacy'}).locator('.collab-evidence-chip').count(),0);
  await page.locator('.collab-card').filter({hasText:'Other revision'}).getByText('ACDD · no verified record').waitFor();
  const feed=page.getByLabel('Verifier activity');
  for(const phase of ['red','green','refactor','integration']) assert.match(await feed.innerText(),new RegExp(`${phase}:`));
  assert.equal(await feed.locator('[data-verifier="done"]').count(),0);
  await feed.getByText(`Historical · green: valid (passed) at ${'a'.repeat(40)}`,{exact:true}).waitFor();
  await feed.getByText('Historical · review: unrun (not run)',{exact:true}).waitFor();
  await page.evaluate(token=>hostViews.openAcddEvidence(token),app.token);
  await page.getByRole('button',{name:'Pricing fixture'}).click();
  await page.locator('.acdd-status-not-run').getByText('Not run').waitFor();
  assert.deepEqual(snapshot(root),before); assert.ok(evidenceGets.length>=4); assert.deepEqual([...new Set(evidenceGets)],['GET']); assert.deepEqual(errors,[]);
});
