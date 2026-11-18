// Run with Node >=22 and Playwright Chromium. Real shell, real renderer, R16
// proxy, R12 stream and ledger append. Only the owner callback is a recorder.
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {createRailsProxy} from '../server/rails-proxy.mjs';

const fixture=spawn('python3',['-B',new URL('./hive-follow.browser.py',import.meta.url).pathname],{stdio:['pipe','pipe','inherit']});
const exit=once(fixture,'exit');
const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
const next=async()=>JSON.parse((await lines.next()).value);
const command=async op=>{fixture.stdin.write(op+'\n');return next();};
let server,browser;
try {
  const {reader,port,first}=await next(), owner=randomUUID();
  const {outputFiles}=await build({entryPoints:['src/rails-shell.ts'],bundle:true,format:'esm',write:false,loader:{'.css':'empty'}});
  const types={'index.html':'text/html','rails.js':'text/javascript','app.js':'text/javascript','inspector.js':'text/javascript','styles.css':'text/css'};
  let proxy;
  const calls=[];
  server=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/api/rizzstack/rails/')){calls.push(req.url);return proxy(req,res);}
    if(req.url==='/shell.js'){res.setHeader('Content-Type','text/javascript');return res.end(outputFiles[0].contents);}
    if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><title>Selected history fixture</title>');}
    const name=req.url.slice('/rails-pane/'.length);
    if(req.url.startsWith('/rails-pane/')&&Object.hasOwn(types,name)){
      res.setHeader('Content-Type',types[name]);res.setHeader('Access-Control-Allow-Origin','*');
      return res.end(await readFile(new URL('../apps/rizzstack-rails/'+name,import.meta.url)));
    }
    res.writeHead(404);res.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  proxy=createRailsProxy({token:owner,port:server.address().port,upstreamPort:port,readToken:reader});
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--disable-dev-shm-usage']});
  const page=await browser.newPage();page.setDefaultTimeout(8000);
  await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  await page.goto(origin);
  await page.evaluate(async credential=>{
    const {openRailsShell}=await import('/shell.js');window.signals=[];
    openRailsShell(()=>credential,{kind:'attempt',id:'att-fixture'},()=>{},(...args)=>window.signals.push(args));
  },owner);
  const dialog=page.getByRole('dialog',{name:'Rizzstack Rails'});
  const marks=page.frameLocator('iframe[title="Read-only Rails timeline"]');
  const mark=id=>marks.locator(`.rail-mark[data-event-id="${id}"]`);
  const inspect=()=>dialog.getByRole('button',{name:'Inspect history'}).click();
  const seen=()=>page.evaluate(()=>window.signals);
  const count=event=>page.evaluate(e=>window.signals.filter(([s])=>s===e).length,event);
  const until=(s,n=1)=>page.waitForFunction(([s,n])=>window.signals.filter(([v])=>v===s).length>=n,[s,n]);
  assert.deepEqual(calls,[]);assert.deepEqual(await seen(),[]);
  assert.ok(await dialog.getByRole('button',{name:'Return to latest page'}).isDisabled());
  await inspect();await mark(first).waitFor();await dialog.getByText(/Connected to updates/).waitFor();
  assert.deepEqual(await seen(),[['following']]);
  // A real post-handoff append must repaint the authoritative selected history
  // and invoke exactly the finite invalidation callback, with no synthetic mark.
  const other=await command('unrelated');const start=performance.now();
  const added=await command('append');await mark(added).waitFor();await until('invalidated');
  const elapsed=Math.round(performance.now()-start);
  assert.deepEqual(await seen(),[['following'],['invalidated']]);
  assert.equal(await mark(other).count(),0);
  assert.equal(calls.filter(path=>path.includes('/stream?')).length,1);
  assert.ok(elapsed<5000,'selected observation should precede the 5s fallback poll');

  // While the reader is offline, an append belongs to recovered history; it
  // must render but cannot be redispatched as a fresh host invalidation.
  await command('stop');await until('reconnecting');const offline=await command('append');
  await command('restart');await mark(offline).waitFor();await until('following',2);
  assert.equal(await count('invalidated'),1);
  const fresh=await command('append');await mark(fresh).waitFor();await until('invalidated',2);

  await command('stop');await until('reconnecting',2);const replacement=await command('replace');
  await mark(replacement).waitFor();await until('following',3);await until('gap');
  assert.equal(await count('invalidated'),2);assert.equal(await mark(offline).count(),0);

  // The owner can inspect another selector in Rails. That query is NOT Hive's
  // selection; even real R12 appends in that scope cannot wake the host.
  const otherBaseline=await command('unrelated');
  await dialog.getByLabel('Public selector ID').fill('att-other');await inspect();
  await mark(otherBaseline).waitFor();await dialog.getByText(/Connected to updates/).waitFor();
  const unrelated=await command('unrelated');await mark(unrelated).waitFor();
  assert.deepEqual(await seen(),[['following'],['invalidated'],['reconnecting'],['following'],['invalidated'],['reconnecting'],['gap'],['following'],['idle']]);

  await dialog.getByLabel('Public selector ID').fill('att-fixture');await inspect();await until('following',4);
  await command('revoke');await dialog.getByText(/Unauthorized/).waitFor();await until('idle',2);
  assert.equal(await count('invalidated'),2);assert.equal(await mark(replacement).count(),0);
  await dialog.getByRole('button',{name:'Close Rails'}).click();assert.ok((await seen()).every(a=>a.length===1));
  console.log(`PASS: R12 append → selected mark + finite host callback in ${elapsed}ms; offline replay and selector switch suppressed; ledger replacement reports gap, credential rejection retires follow.`);
} finally {
  await browser?.close();server?.closeAllConnections();server?.close();fixture.stdin.end();await exit;
}
