import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalHostProvider, captureHistory } from '../server/local-host.mjs';

test('startup tmux configuration is explicit, validated and shared with history capture', async t => {
  const previousSocket = process.env.ORBIT_TMUX_SOCKET;
  const previousConfig = process.env.ORBIT_TMUX_CONFIG;
  t.after(() => {
    if (previousSocket === undefined) delete process.env.ORBIT_TMUX_SOCKET;
    else process.env.ORBIT_TMUX_SOCKET = previousSocket;
    if (previousConfig === undefined) delete process.env.ORBIT_TMUX_CONFIG;
    else process.env.ORBIT_TMUX_CONFIG = previousConfig;
  });
  process.env.ORBIT_TMUX_SOCKET = 'orbit-fixture-' + randomUUID();
  process.env.ORBIT_TMUX_CONFIG = '/dev/null';
  const provider = new LocalHostProvider();
  assert.equal(provider.tmuxSocket, process.env.ORBIT_TMUX_SOCKET);
  assert.equal(provider.tmuxConfig, '/dev/null');
  for (const value of ['../owner', '/tmp/socket', '-bad', '', 'a'.repeat(81)]) {
    assert.throws(() => new LocalHostProvider({ tmuxSocket: value }), /Invalid tmux socket/);
    await assert.rejects(captureHistory(randomUUID(), value), /Invalid tmux socket/);
  }
});

test('persistent host shell retains variable and PID across PTY client disconnect', async () => {
  const pane_id = randomUUID();
  const tmuxSocket = `orbit-test-${pane_id.replaceAll('-', '')}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-persistent-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(home);
  await mkdir(cwd);
  const provider = new LocalHostProvider({ tmuxSocket, home, cwd, tmuxConfig:'/dev/null', env:{PATH:process.env.PATH,HOME:home,SHELL:'/bin/bash'} });
  let first, second;
  const attach = () => provider.spawn({ cols: 80, rows: 24, pane_id });
  const wait = (pty, command, marker) => new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      clearTimeout(writeTimer);
      subscription.dispose();
      reject(Error(`Timed out waiting for ${marker}: ${output}`));
    }, 8000);
    const subscription = pty.onData((chunk) => {
      output += chunk;
      if (output.includes(marker)) {
        clearTimeout(timer);
        clearTimeout(writeTimer);
        subscription.dispose();
        resolve(output);
      }
    });
    const writeTimer = setTimeout(() => pty.write(`${command}\r`), 250);
  });
  try {
    first = attach();
    const before = await wait(first, "export ORBIT_PERSIST_TEST=retained; printf 'STATE_%s_%s\\n' \"$ORBIT_PERSIST_TEST\" \"$$\"", 'STATE_retained_');
    const pidMatch = before.match(/STATE_retained_(\d+)/);
    assert.ok(pidMatch, `Initial shell PID missing: ${before}`);
    const firstPid = pidMatch[1];
    assert.match(await captureHistory(pane_id, tmuxSocket), new RegExp(`STATE_retained_${firstPid}`));
    first.kill();
    first = undefined;
    second = attach();
    const after = await wait(second, "printf 'REATTACHED_%s_%s\\n' \"$ORBIT_PERSIST_TEST\" \"$$\"", 'REATTACHED_retained_');
    const afterMatch = after.match(/REATTACHED_retained_(\d+)/);
    assert.ok(afterMatch, `Reattached shell state missing: ${after}`);
    assert.equal(afterMatch[1], firstPid, 'the reattached client must observe the same shell PID');
  } finally {
    first?.kill();
    second?.kill();
    try {
      execFileSync('/usr/bin/tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore', timeout: 3000 });
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
});
