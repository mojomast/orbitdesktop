import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSshHosts } from '../server/ssh-hosts.mjs';

const SSHD = process.env.ORBIT_TEST_SSHD || '/usr/sbin/sshd';
const INSTALL_ID = 'sshdtest01';

function binaryWorks(file, args = ['-V']) {
  try {
    const result = spawnSync(file, args, { encoding: 'utf8', timeout: 5000 });
    return result.error ? false : result.status === 0 || Boolean(result.stderr);
  } catch {
    return false;
  }
}

const haveSshd = fs.existsSync(SSHD) && binaryWorks(SSHD);
const haveSsh = binaryWorks('ssh');
const haveKeygen = binaryWorks('ssh-keygen', ['-?']);
const haveKeyscan = binaryWorks('ssh-keyscan', ['-V']);
const skipReason = !haveSshd
  ? `No throwaway sshd available (set ORBIT_TEST_SSHD); looked for ${SSHD}`
  : !haveSsh
    ? 'No ssh client available for a throwaway sshd test'
    : !haveKeygen
      ? 'No ssh-keygen available for a throwaway sshd test'
      : !haveKeyscan
        ? 'No ssh-keyscan available for a throwaway sshd test'
        : false;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, child, stderr) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error(`sshd exited early: ${stderr.text}`));
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) return reject(new Error(`sshd did not listen: ${stderr.text}`));
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function sshdConfig(box, port) {
  const lines = [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${path.join(box.root, 'ssh_host_ed25519_key')}`,
    `PidFile ${path.join(box.root, 'sshd.pid')}`,
    `AuthorizedKeysFile ${path.join(box.root, 'authorized_keys')}`,
    'StrictModes no',
    'UsePAM no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'PermitRootLogin prohibit-password',
    'AllowAgentForwarding no',
    'X11Forwarding no',
    'PrintMotd no',
    'LogLevel VERBOSE',
  ];
  if (process.env.ORBIT_TEST_SSHD_SESSION) lines.push(`SshdSessionPath ${process.env.ORBIT_TEST_SSHD_SESSION}`);
  if (process.env.ORBIT_TEST_SSHD_AUTH) lines.push(`SshdAuthPath ${process.env.ORBIT_TEST_SSHD_AUTH}`);
  return `${lines.join('\n')}\n`;
}

function writeHostKey(box) {
  fs.rmSync(path.join(box.root, 'ssh_host_ed25519_key'), { force: true });
  fs.rmSync(path.join(box.root, 'ssh_host_ed25519_key.pub'), { force: true });
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'orbit-test-host', '-f', path.join(box.root, 'ssh_host_ed25519_key')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ssh-keygen host key failed: ${result.stderr}`);
}

async function startSshd(box, port) {
  const configFile = path.join(box.root, 'sshd_config');
  fs.writeFileSync(configFile, sshdConfig(box, port), { mode: 0o600 });
  const stderr = { text: '' };
  const child = spawn(SSHD, ['-D', '-e', '-f', configFile], { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C' } });
  child.stderr.on('data', chunk => { stderr.text += chunk.toString('utf8').slice(0, 8000); });
  try {
    await waitForPort(port, child, stderr);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return { child, configFile, stderr };
}

async function stopSshd(server) {
  if (!server) return;
  if (server.child.exitCode === null) {
    server.child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { server.child.kill('SIGKILL'); resolve(); }, 3000);
      server.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

function closeControlMaster(configFile, alias, home) {
  spawnSync('ssh', ['-O', 'exit', '-F', configFile, alias], {
    encoding: 'utf8',
    timeout: 5000,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, LANG: 'C', LC_ALL: 'C' },
  });
}

test('throwaway sshd: add, verified pin, preflight, key-change lock and local revoke', { skip: skipReason }, async () => {
  const box = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-sshd-')) };
  let server = null;
  const alias = 'orbit-sshd-host';
  try {
    writeHostKey(box);
    const port = await freePort();
    server = await startSshd(box, port);

    const config = { installId: INSTALL_ID, components: {}, hosts: [] };
    const logs = [];
    const hosts = createSshHosts({ runtimeDir: box.root, config, exec: undefined, log: (message, meta) => logs.push({ message, meta }) });
    const added = await hosts.add({
      id: 'sshd-host',
      label: 'Throwaway sshd',
      address: '127.0.0.1',
      port,
      user: os.userInfo().username,
      tags: [],
      roles: ['worker'],
      transport: { kind: 'direct', jumpHostId: null, tailcatAddrRef: null, cloudflareHostname: null },
      auth: { kind: 'orbit-key', keyId: 'orbit-default' },
      privilege: { sudo: 'none', docker: 'none', forcedCommand: false, terminal: false },
      permissions: { setup: 'deploy', pi: 'none', opencode: 'none', hermes: 'none', bundlebees: 'none' },
    });
    assert.equal(added.status.state, 'unreachable');

    const authorized = path.join(box.root, 'authorized_keys');
    fs.writeFileSync(authorized, `${added.authorizedKeysLine}\n`, { mode: 0o600 });
    assert.match(fs.readFileSync(authorized, 'utf8'), new RegExp(`orbit-${INSTALL_ID}`));

    const scanned = await hosts.scanHostKey('sshd-host');
    assert.match(scanned.fingerprint, /^SHA256:/);
    await assert.rejects(() => hosts.confirmPin('sshd-host', 'SHA256:this-is-not-the-scanned-fingerprint'), /fingerprint/i);
    const pinned = await hosts.confirmPin('sshd-host', scanned.fingerprint);
    assert.equal(pinned.status.state, 'verified');

    const tested = await hosts.test('sshd-host');
    assert.equal(tested.ok, true, JSON.stringify(tested));
    assert.equal(tested.preflight.arch.length > 0, true);
    assert.equal(hosts.status('sshd-host').status.state, 'verified');

    closeControlMaster(path.join(box.root, 'ssh', 'config'), alias, box.root);
    writeHostKey(box);
    await stopSshd(server);
    server = await startSshd(box, port);

    const changed = await hosts.test('sshd-host');
    assert.equal(changed.ok, false);
    assert.equal(changed.reason, 'key-changed');
    assert.equal(hosts.status('sshd-host').status.state, 'key-changed');
    const blocked = await hosts.test('sshd-host');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'key-changed');

    const revoked = await hosts.revoke('sshd-host');
    assert.equal(revoked.state, 'revoked');
    assert.match(revoked.authorizedKeysLine, /^restrict,pty ssh-ed25519 /);
    assert.doesNotMatch(fs.readFileSync(path.join(box.root, 'ssh', 'known_hosts'), 'utf8'), /orbit-sshd-host/);
    const after = await hosts.test('sshd-host');
    assert.equal(after.ok, false);
    assert.equal(after.reason, 'revoked');
    assert.ok(!JSON.stringify({ config, added, pinned, tested, changed, revoked, after, logs }).includes('BEGIN OPENSSH PRIVATE KEY'));
  } finally {
    closeControlMaster(path.join(box.root, 'ssh', 'config'), alias, box.root);
    await stopSshd(server);
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});
