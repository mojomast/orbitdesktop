import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('official regression tests and their fixtures use portable filesystem roots', () => {
  const root=fileURLToPath(new URL('./',import.meta.url));
  const files=['../scripts/check-local.mjs','../scripts/ci-offline-check.sh','../scripts/smoke-node-quickstart.mjs'];
  function walk(dir,keep) {
    for(const d of fs.readdirSync(path.join(root,dir),{withFileTypes:true})) {
      const name=path.join(dir,d.name);
      if(d.isDirectory() && d.name!=='node_modules') walk(name,keep);
      else if(d.isFile() && keep.test(name)) files.push(name);
    }
  }
  walk('.',/\.mjs$/); walk('fixtures',/\.(?:js|ts|py|json|sh)$/);
  const authorPath=/\/(?:tmp\/opencode|home\/(?:mojo|kyle)|Users\/(?:mojo|kyle))(?:\/|['"`])/i;
  const bad=files.filter(name=>authorPath.test(fs.readFileSync(path.join(root,name),'utf8')));
  assert.deepEqual(bad,[],'Use tests/fixtures/scratch.mjs or an explicitly provisioned fixture.');
});

test('official gate gives child processes private state and only loopback', {skip:process.env.ORBIT_TEST_GATE!=='1' && 'run via npm test or check-local preflight'}, () => {
  const tmp=os.tmpdir(), home=os.homedir();
  assert.notEqual(tmp,home); assert.equal(path.dirname(tmp),path.dirname(home));
  for(const dir of [tmp,home,path.dirname(tmp)]) assert.equal(fs.statSync(dir).mode & 0o077,0);
  assert.equal(process.env.TMUX_TMPDIR,tmp);
  assert.ok(process.env.npm_config_cache.startsWith(home+path.sep));
  for(const key of ['SSH_AUTH_SOCK','GITHUB_TOKEN','GH_TOKEN','OPENAI_API_KEY','ORBIT_TOKEN','HERMES_HOME','NODE_OPTIONS','HTTP_PROXY','HTTPS_PROXY']) assert.equal(process.env[key],undefined,key);
  const child=JSON.parse(execFileSync(process.execPath,['-e',`const os=require('node:os');console.log(JSON.stringify({home:os.homedir(),tmp:os.tmpdir(),interfaces:Object.keys(os.networkInterfaces())}))`],{encoding:'utf8'}));
  assert.deepEqual(child,{home,tmp,interfaces:['lo']});
});
