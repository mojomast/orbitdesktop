import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function boot(t, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wiring-'));
  const home = path.join(root,'home'), runtime = path.join(root,'runtime'), bin = path.join(root,'bin');
  for (const dir of [home,runtime,bin]) fs.mkdirSync(dir, { mode: 0o700 });
  const marker = path.join(root, 'docker-called');
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\ntouch "$HOME/../docker-called"\nexit 1\n', { mode: 0o755 });
  const port = await new Promise((resolve,reject) => {
    const probe = net.createServer(); probe.once('error',reject);
    probe.listen(0,'127.0.0.1', () => { const {port} = probe.address(); probe.close(() => resolve(port)); });
  });
  const token = randomBytes(32).toString('hex');
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--experimental-strip-types','server/index.mjs'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: ['ignore','pipe','pipe'],
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: root, PORT: String(port), ORBIT_HOST: '127.0.0.1', ORBIT_TOKEN: token,
      ORBIT_CWD: root, ORBIT_RUNTIME_DIR: runtime, ORBIT_AGENT_DISCOVERY: 'off', PI_HARNESS_DISABLED: '1', ORBIT_TMUX_CONFIG: '/dev/null', ORBIT_TMUX_SOCKET: `test-${port}`, ...extraEnv },
  });
  let logs = '';
  for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk => { logs = (logs + chunk).slice(-65536); });
  const exited = new Promise(resolve => child.once('exit',resolve));
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM'); const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(kill); }
    }
    fs.rmSync(root,{recursive:true,force:true});
  });
  for (let i = 0; ; i++) {
    if (child.exitCode !== null || child.signalCode || i === 200) throw Error(logs.replaceAll(token,'[redacted]') || 'Server did not start');
    try { if ((await fetch(base+'/api/health')).ok) break; } catch { /* starting */ }
    await delay(50);
  }
  const bodies = [];
  async function call(method, pathname, body, headers = {}) {
    const response = await fetch(base+pathname,{ method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {'Content-Type':'application/json', Origin:base}), ...headers }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    const text = await response.text(); bodies.push(text);
    let data = {}; try { data = JSON.parse(text); } catch { /* non-JSON response */ }
    return {status:response.status, data};
  }
  return {base, token, call, bodies, runtime, marker, logs:() => logs};
}
