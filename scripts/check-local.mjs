// Official Linux/Node regression gate. Installation is separate. Use a real
// network namespace so npm, Python, native addons and child processes all
// have the same offline boundary (a mocked fetch would not achieve this).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('..',import.meta.url));
const mode = process.argv[2];
if (!['test','check','preflight'].includes(mode)) throw Error('Expected test, check or preflight.');
if (process.platform !== 'linux') throw Error('Use the Linux test container; the regression suite requires Linux tmux, PTY and sshd.');
const interfaces = fs.readFileSync('/proc/self/net/dev','utf8').split('\n').slice(2).map(line=>line.split(':')[0].trim()).filter(Boolean);
if (interfaces.length !== 1 || interfaces[0] !== 'lo') {
  if (process.argv[3] === '--in-netns') throw Error('Test namespace must have loopback only.');
  const args = [...(process.getuid() === 0 ? [] : ['--user','--map-root-user']),'--net','--','sh','-ec','ip link set lo up; exec "$@"','--',process.execPath,fileURLToPath(import.meta.url),mode,'--in-netns'];
  const result=spawnSync('unshare',args,{stdio:'inherit'});
  if(result.status!==0) console.error('Check requires a loopback-only network. If unshare is restricted, run inside a disposable Linux container with --network=none.');
  process.exit(result.status ?? 1);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(),'oc-'));
try {
  const home=path.join(root,'h'), tmp=path.join(root,'t');
  for(const dir of [home,tmp]) fs.mkdirSync(dir,{mode:0o700});
  const env={PATH:[path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':'),HOME:home,TMPDIR:tmp,LANG:'C.UTF-8',
    ORBIT_TEST_GATE:'1', TMUX_TMPDIR:tmp, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1', GIT_NO_LAZY_FETCH:'1', GIT_ALLOW_PROTOCOL:'file', GIT_TERMINAL_PROMPT:'0',
    npm_config_cache:path.join(home,'.npm'), npm_config_offline:'true',npm_config_fund:'false',npm_config_audit:'false',npm_config_update_notifier:'false'};
  // Only explicitly provisioned opt-in test inputs, never provider keys,
  // service URLs, SSH agents, setup configs, NPM tokens or personal profiles.
  if(process.env.ORBIT_TEST_PROVISIONED === '1') {
    for(const name of ['HERMES_NATIVE_SOURCE','HERMES_PINNED_SOURCE','HERMES_PINNED_PYTHON','ORBIT_ROUTETOK_TEST_SOURCE','ORBIT_ROUTETOK_TEST_CACHE','ORBIT_DUCKDB_EXTENSIONS_ROOT','ORBIT_TEST_MODEL_DIR','ORBIT_TEST_CUA_PYTHON']) {
      if(process.env[name]) env[name]=process.env[name];
    }
  }
  function run(args) {
    const result=spawnSync(process.execPath,args,{cwd:repo,env,stdio:'inherit'});
    if(result.error) throw result.error;
    if(result.status !== 0) throw Error(`${args[0]} failed (${result.status ?? result.signal}).`);
  }
  console.log('Orbit check: loopback only; disposable HOME, temp, tmux and npm cache.');
  if(mode==='check') {
    run(['scripts/generate-workspace-contract.mjs','--check']);
    run(['--experimental-strip-types','scripts/generate-workbench-contract.mjs','--check']);
    run(['scripts/isolated_build.mjs']);
  }
  const tests=mode==='preflight'?['runnable-portability.test.mjs','onboarding-wiring.test.mjs','workspace-store-placement.test.mjs','project-files-adversarial.test.mjs']
    :fs.readdirSync(path.join(repo,'tests')).filter(name=>name.endsWith('.test.mjs')).sort();
  run(['--experimental-strip-types','--test','--test-concurrency=1',...tests.map(name=>'tests/'+name)]);
} finally { fs.rmSync(root,{recursive:true,force:true}); }
