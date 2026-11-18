#!/usr/bin/env node
// Rehearse the documented Node quickstart from a local, committed source
// mirror. The caller provisions a cache and toolchain; never hydrate them
// online here. No checked-out files, owner home, or runtime are reused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'linux' || Object.keys(os.networkInterfaces()).some(name => name !== 'lo')) {
  throw Error('Use a disposable loopback-only Linux network namespace or --network=none container.');
}
const [source, cache, chrome] = process.argv.slice(2);
if (![source,cache,chrome].every(value => typeof value === 'string' && path.isAbsolute(value))) {
  throw Error('Usage: node scripts/smoke-node-quickstart.mjs /local/source-repo /seeded/npm-cache /chromium');
}
const root = fs.mkdtempSync(path.join(os.tmpdir(),'o-quick-'));
const checkout = path.join(root,'orbitdesktop');
const home = path.join(root,'home'), tmp = path.join(root,'tmp');
fs.mkdirSync(home,{mode:0o700}); fs.mkdirSync(tmp,{mode:0o700});
const env = { PATH:process.env.PATH, HOME:home, TMPDIR:tmp, TMUX_TMPDIR:tmp,
  ORBIT_TMUX_CONFIG:'/dev/null', ORBIT_TMUX_SOCKET:`quick-${process.pid}`, ORBIT_CWD:checkout,
  GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', GIT_ALLOW_PROTOCOL:'file',
  npm_config_cache:cache, npm_config_offline:'true', npm_config_update_notifier:'false', npm_config_fund:'false', npm_config_audit:'false', ONNXRUNTIME_NODE_INSTALL:'skip',
  ...(process.env.npm_config_nodedir ? {npm_config_nodedir:process.env.npm_config_nodedir} : {}) };
const base = 'http://127.0.0.1:4318'; // documented default, in the disposable namespace
let child, browser, exited, stub, started=false;
try {
  execFileSync('git',['-c','core.hooksPath=/dev/null','clone','--depth=1','--no-local','--no-hardlinks',pathToFileURL(source).href,checkout],{env,stdio:'inherit'});
  for (const name of ['node_modules','dist','.runtime']) assert.equal(fs.existsSync(path.join(checkout,name)),false,`fresh clone contains ${name}`);
  assert.equal(execFileSync('git',['status','--porcelain'],{env,cwd:checkout,encoding:'utf8'}),'');
  const lock=fs.readFileSync(path.join(checkout,'package-lock.json'));
  console.log('Running npm ci against the original lockfile.');
  execFileSync('npm',['ci'],{env,cwd:checkout,stdio:'inherit',timeout:20*60_000});
  assert.deepEqual(fs.readFileSync(path.join(checkout,'package-lock.json')),lock);
  child=spawn('npm',['run','up'],{env,cwd:checkout,detached:true,stdio:['ignore','pipe','pipe']});
  exited=new Promise(resolve=>child.once('exit', resolve));
  let last=''; for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{last=(last+chunk).slice(-4096);});
  for(let i=0;;i++) {
    if(child.exitCode!==null || child.signalCode || i===1800) throw Error(`Quickstart failed (exit=${child.exitCode}, signal=${child.signalCode}); see install/build diagnostics.`);
    try {if((await fetch(base+'/api/health')).ok) break;} catch {} await delay(500);
  }
  assert.ok(fs.existsSync(path.join(checkout,'dist','index.html')));
  started=true;
  const login=execFileSync('npm',['run','up','--','--print-login-url'],{env,cwd:checkout,encoding:'utf8'});
  assert.ok(login.includes(`Orbit login: ${base}\n`),'wrong login origin');
  const token=login.match(/^One-time token: (\S+)$/m)?.[1]; assert.ok(token && token.length>=32);
  const headers={Authorization:`Bearer ${token}`,Origin:base,'Content-Type':'application/json'};
  const first=await (await fetch(base+'/api/onboarding/state',{headers})).json();
  assert.equal(first.firstRun,true); assert.deepEqual(first.config.providers,[]);
  assert.ok(!last.includes(token),'server logs contained the fixture owner credential');
  const {chromium}=createRequire(path.join(checkout,'package.json'))('playwright-core');
  // Orbit suppresses the automatic first-run wizard for webdriver clients.
  // Exercise its ordinary first-visit branch at the printed URL, without
  // seeding tour state, injecting a token or forcing a setup query string.
  browser=await chromium.launch({executablePath:chrome,env,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--disable-blink-features=AutomationControlled']});
  const page=await browser.newPage({viewport:{width:1280,height:900}}); page.setDefaultTimeout(30_000);
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.goto(base);
  await page.getByRole('dialog').getByRole('button',{name:/^Connect host:/}).click();
  await page.getByRole('textbox',{name:'Host session token'}).fill(token);
  await page.getByRole('button',{name:'Unlock local host',exact:true}).click();
  const wizard=page.getByRole('dialog',{name:'Orbit setup'});
  await wizard.getByRole('heading',{name:'Choose what to install'}).waitFor();
  await wizard.getByText('Minimal install (recommended)',{exact:true}).waitFor();
  console.log('Fresh build served on loopback; zero configured agents; Chromium unlocked and rendered setup.');
  // No external provider. Exercise the normal local provider choice and
  // verify the resulting first-agent configuration after Apply.
  stub=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"data":[{"id":"fixture-model"}]}');});
  await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
  await wizard.locator('#minimal-path').check();
  await wizard.getByRole('button',{name:'Continue to the next setup step'}).click();
  const providerBase=`http://127.0.0.1:${stub.address().port}/v1`;
  await wizard.getByLabel('Provider id',{exact:true}).fill('fixture');
  await wizard.getByLabel('Provider label').fill('Fixture');
  await wizard.getByLabel('Provider base URL').fill(providerBase);
  await wizard.getByRole('button',{name:'Add provider'}).click();
  // The fixture actually serves the model list. Wait for that option and
  // select it, rather than racing the asynchronous loader in the manual field.
  await wizard.getByLabel('Minimal install model').selectOption('fixture-model');
  await wizard.getByRole('button',{name:'Continue to the next setup step'}).click();
  await wizard.getByRole('button',{name:'Apply setup choices'}).click();
  await wizard.getByRole('button',{name:'Apply setup choices',disabled:true}).waitFor();
  const applied=await (await fetch(base+'/api/onboarding/state',{headers})).json();
  assert.equal(applied.firstRun,false); assert.equal(applied.roles.chat.model,'fixture-model'); assert.equal(applied.config.router.enabled,false);
  console.log('Minimal first-agent configuration saved with a loopback model fixture.');
} finally {
  try {
    await browser?.close(); if(stub) await new Promise(resolve=>stub.close(resolve));
    if(child?.pid){
      try {process.kill(-child.pid,'SIGINT');} catch(e) {if(e.code!=='ESRCH') throw e;}
      await Promise.race([exited,delay(5000)]);
      if(started){
        for(let i=0;i<50;i++){
          try {await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)});} catch(e) {if(e.cause?.code==='ECONNREFUSED') break; throw e;}
          if(i===49) throw Error('Orbit still listening after Ctrl+C');
          await delay(100);
        }
        assert.ok(child.exitCode!==null||child.signalCode,'npm did not exit after Ctrl+C');
        console.log('Ctrl+C stopped the launcher; the Orbit port refuses connections.');
      }
    }
  } finally {
    if(child?.pid) {try {process.kill(-child.pid,'SIGKILL');} catch(e) {if(e.code!=='ESRCH') throw e;}}
    fs.rmSync(root,{recursive:true,force:true});
  }
}
