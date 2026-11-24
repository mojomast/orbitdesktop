import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createOrbitConfig } from '../../server/orbit-config.mjs';
import { createRouterSupervisor } from '../../server/router-supervisor.mjs';
import { startHostRouter } from '../../server/router-host.mjs';

// Native fixture takes no network actions and cannot issue or validate keys.
// It reports only whether the invocation/credential boundary is as expected.
const fixtureCode = `#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>
#include <string.h>
int main(int argc,char **argv) {
  if (argc!=7 || strcmp(argv[1],"-host") || strcmp(argv[2],"127.0.0.1") ||
      strcmp(argv[3],"-port") || strcmp(argv[4],"8484") || strcmp(argv[5],"-app-dir") ||
      access("data/config.json",R_OK) || getenv("PATH") || getenv("LD_PRELOAD") || !getenv("ROUTER_VK_WORKERS") ||
      !getenv("BIFROST_ADMIN_PASSWORD") || !getenv("ROUTER_UPSTREAM_LOCAL_KEY")) return 3;
  FILE *out=fopen("fixture-ready","wx"); if(!out) return 4; fclose(out);
  for (;;) pause();
}`;

function setup(t, needFixture = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-host-router-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir,'fixture'), runtimeDir = path.join(dir,'runtime');
  if (needFixture) {
    if (spawnSync('cc',['--version']).status !== 0) { t.skip('C compiler required for local no-listener child'); return; }
    execFileSync('cc',['-x','c','-o',binary,'-'], {input: fixtureCode});
  } else {
    fs.copyFileSync('/bin/false', binary);
  }
  fs.chmodSync(binary,0o500);
  fs.mkdirSync(runtimeDir,{mode:0o700});
  const store = createOrbitConfig({runtimeDir,env:{}});
  const config = store.load();
  config.router.enabled = config.components.router = true;
  Object.assign(config.router,{bind:'loopback',port:8484,upstreams:[{providerId:'local',weight:1}]});
  config.providers.push({id:'local',kind:'openai-compatible',label:'Example',baseUrl:'https://upstream.invalid/v1'});
  config.roles.workers = {provider:'router',model:'local/example'};
  store.save(config);
  store.setKey('local','not-a-provider-credential');
  const supervisor = createRouterSupervisor({config:store.load(),runtimeDir,exec:assert.fail,fetchImpl:assert.fail});
  supervisor.prepareBuiltin();
  const manifestFile = path.join(dir,'manifest.json');
  const manifest = {runtimeDir,binary,engine:'bifrost',version:'2.5.1',sha256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex')};
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), {mode:0o600});
  const options = {runtimeDir,manifestFile,confirmStart:true};
  return {manifest,options,binary,store,supervisor,start:()=>startHostRouter(options),run:path.join(runtimeDir,'router/host-run')};
}

test('binary_litellm_and_external_modes_follow_the_pin_rules: host binary start and stop', {skip: process.platform !== 'linux'}, async t => {
  const h=setup(t,true); if (!h) return;
  const child=await h.start();
  try {
    for(let i=0;i<100 && !fs.existsSync(path.join(h.run,'fixture-ready'));i++) await delay(10);
    assert.ok(fs.existsSync(path.join(h.run,'fixture-ready')));
    await assert.rejects(h.start(), /EEXIST/);
    assert.throws(()=>h.supervisor.prepareBuiltin(),/Stop the foreground/);
    await assert.rejects(h.supervisor.disable({confirm:true}),/Stop the foreground/);
  } finally { await child.stop(); }
  assert.equal((await child.done).signal,'SIGTERM');
  assert.ok(!fs.existsSync(h.run));
});

test('no launch on missing consent, tampered binary, writable manifest, config drift, or role credential mismatch', {skip:process.platform !== 'linux'}, async t=>{
  const h=setup(t), {runtimeDir,manifestFile}=h.options;
  const launch=()=>startHostRouter(h.options);
  await assert.rejects(startHostRouter({...h.options,confirmStart:false}),/Explicit/);
  fs.chmodSync(manifestFile,0o644); await assert.rejects(launch,/permissions/); fs.chmodSync(manifestFile,0o600);
  fs.writeFileSync(manifestFile,JSON.stringify({...h.manifest,version:'2.5.2'})); await assert.rejects(launch,/manifest/);
  fs.writeFileSync(manifestFile,JSON.stringify({...h.manifest,sha256:'0'.repeat(64)})); await assert.rejects(launch,/checksum/);
  fs.writeFileSync(manifestFile,JSON.stringify(h.manifest));
  const file=path.join(runtimeDir,'router/data/config.json');
  const original=fs.readFileSync(file,'utf8'), changed=JSON.parse(original);
  changed.client.enforce_auth_on_inference=false; fs.writeFileSync(file,JSON.stringify(changed));
  await assert.rejects(launch,/governance/); fs.writeFileSync(file,original);
  const routerEnv=path.join(runtimeDir,'router/router.env'), env=fs.readFileSync(routerEnv,'utf8');
  fs.appendFileSync(routerEnv,'EXTRA=blocked\n'); await assert.rejects(launch,/environment/); fs.writeFileSync(routerEnv,env);
  fs.copyFileSync(path.join(runtimeDir,'keys/router-vk-chat.key'),path.join(runtimeDir,'keys/router-vk-workers.key'));
  await assert.rejects(launch,/role credential/);
  assert.ok(!fs.existsSync(h.run));
});
