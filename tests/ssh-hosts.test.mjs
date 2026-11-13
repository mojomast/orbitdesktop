import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureInstallKey,
  createHostKey,
  publicKey,
  fingerprint,
  fingerprintFromPublicKey,
  rotatePlan,
} from '../server/ssh-keys.mjs';
import {
  renderSshConfig,
  writeSshConfig,
} from '../server/ssh-config.mjs';
import {
  createSshHosts,
  isHostKeyChanged,
  parseAddress,
} from '../server/ssh-hosts.mjs';
import { bootstrapScript, oneLiner } from '../server/ssh-bootstrap.mjs';

const PRIVATE_SENTINEL = 'ORBIT-TEST-PRIVATE-KEY-SENTINEL';
const INSTALL_ID = 'testinstall01';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ssh-'));
  return { root, cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}

/** A syntactically valid ssh-ed25519 public key generated in-process. */
function makePublicKey() {
  const { publicKey: pk } = crypto.generateKeyPairSync('ed25519');
  const der = pk.export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32);
  const string = Buffer.from('ssh-ed25519');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(string.length);
  const rawPrefix = Buffer.alloc(4);
  rawPrefix.writeUInt32BE(raw.length);
  const blob = Buffer.concat([prefix, string, rawPrefix, raw]);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

const TEST_PUB = makePublicKey();
const TEST_B64 = TEST_PUB.split(' ')[1];

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

/**
 * A fake OpenSSH toolchain. It writes real-shaped files inside the sandbox and
 * records every argv array so tests can assert no shell string is used and no
 * private material leaks through results or logs.
 */
function fakeTools({ fail = null } = {}) {
  const calls = [];
  const exec = async (file, args, options = {}) => {
    calls.push({ file, args: [...args], options });
    assert.ok(Array.isArray(args), 'argv must be an array');
    const base = path.basename(file);
    if (fail && fail(base, args)) throw Object.assign(new Error('command failed'), { stderr: 'failure', code: 255 });
    if (base === 'ssh-keygen') {
      if (args.includes('-lf')) {
        const pubFile = args.at(-1);
        if (args.includes('-E')) return { stdout: `${TEST_PUB} (ED25519)\n`, stderr: '' };
        return { stdout: `256 ${fingerprintFromPublicKey(fs.readFileSync(pubFile, 'utf8'))} ${path.basename(pubFile)} (ED25519)\n`, stderr: '' };
      }
      const fileIdx = args.indexOf('-f');
      const target = args[fileIdx + 1];
      const commentIdx = args.indexOf('-C');
      const comment = commentIdx >= 0 ? args[commentIdx + 1] : 'orbit';
      fs.writeFileSync(target, `-----BEGIN OPENSSH PRIVATE KEY-----\n${PRIVATE_SENTINEL}\n-----END OPENSSH PRIVATE KEY-----\n`, { mode: 0o600 }); // gitleaks:allow (fake test key: a sentinel, not key material)
      fs.writeFileSync(`${target}.pub`, `${TEST_PUB} ${comment}\n`, { mode: 0o644 });
      return { stdout: '', stderr: '' };
    }
    if (base === 'ssh-keyscan') {
      const host = args.at(-1);
      const portIdx = args.indexOf('-p');
      const port = portIdx >= 0 ? args[portIdx + 1] : '22';
      const hostToken = port === '22' ? host : `[${host}]:${port}`;
      return { stdout: `# ${host}:${port} SSH-2.0-OpenSSH_10.0\n${hostToken} ssh-ed25519 ${TEST_B64}\n`, stderr: '' };
    }
    if (base === 'ssh') {
      if (args.includes('-O')) return { stdout: '', stderr: '' };
      const command = args.slice(args.findIndex(arg => arg.startsWith('orbit-')) + 1);
      const joined = command.join(' ');
      if (joined === 'true') return { stdout: '', stderr: '' };
      if (joined.startsWith('uname')) return { stdout: 'x86_64\n', stderr: '' };
      if (joined.startsWith('df')) return { stdout: 'Filesystem Size Used Avail Use%\n/dev/root 40G 1G 39G 3% /\n', stderr: '' };
      if (joined === 'docker --version') return { stdout: 'Docker version 27.0.0, build test\n', stderr: '' };
      if (joined === 'docker compose version') return { stdout: 'Docker Compose version v2.30.0\n', stderr: '' };
      if (joined === 'sudo -n -l') return { stdout: 'NOPASSWD: /bin/systemctl status orbit-*\n', stderr: '' };
      if (joined.startsWith('date')) return { stdout: '2026-11-12T00:00:00Z\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

function hostInput(overrides = {}) {
  return {
    id: 'build-01',
    label: 'Build box',
    address: '203.0.113.10',
    port: 22,
    user: 'orbit',
    tags: ['ci'],
    roles: ['worker', 'infra'],
    transport: { kind: 'direct', jumpHostId: null, tailcatAddrRef: null, cloudflareHostname: null },
    auth: { kind: 'orbit-key', keyId: 'orbit-default' },
    privilege: { sudo: 'none', docker: 'none', forcedCommand: false, terminal: false },
    permissions: { setup: 'deploy', pi: 'none', opencode: 'none', hermes: 'none', bundlebees: 'deploy' },
    ...overrides,
  };
}

function makeHosts(box, tools, config = { installId: INSTALL_ID, components: {}, hosts: [] }) {
  const logs = [];
  const hosts = createSshHosts({
    runtimeDir: box.root,
    config,
    exec: tools.exec,
    log: (message, meta) => logs.push({ message, meta }),
  });
  return { hosts, config, logs };
}

test('parseAddress accepts documented IPv4, host:port and bracketed IPv6 forms', () => {
  assert.deepEqual(parseAddress('deploy@203.0.113.10'), { user: 'deploy', host: '203.0.113.10', port: 22 });
  assert.deepEqual(parseAddress('203.0.113.10:2222'), { user: 'orbit', host: '203.0.113.10', port: 2222 });
  assert.deepEqual(parseAddress('[2001:db8::10]:2200'), { user: 'orbit', host: '2001:db8::10', port: 2200 });
  assert.deepEqual(parseAddress('orbit@[2001:db8::10]'), { user: 'orbit', host: '2001:db8::10', port: 22 });
  for (const bad of ['', 'bad host', 'user@host:0', 'user@host:65536', 'user@host\nInclude x', 'user@@host', '-leading.example']) {
    assert.throws(() => parseAddress(bad), undefined, bad);
  }
});

test('ensureInstallKey creates one 0600 key with the orbit install comment and never returns private material', async () => {
  const box = sandbox();
  try {
    const tools = fakeTools();
    const info = await ensureInstallKey({ runtimeDir: box.root, installId: INSTALL_ID, exec: tools.exec });
    const keyDir = path.join(box.root, 'ssh', 'keys');
    const privateFile = path.join(keyDir, 'orbit-default');
    assert.equal(mode(path.join(box.root, 'ssh')), 0o700);
    assert.equal(mode(keyDir), 0o700);
    assert.equal(mode(privateFile), 0o600);
    assert.equal(info.id, 'orbit-default');
    assert.equal(info.type, 'ed25519');
    assert.deepEqual(info.keyRef, { file: 'ssh/keys/orbit-default' });
    assert.equal(info.publicKey.endsWith(`orbit-${INSTALL_ID}`), true);
    assert.equal(info.fingerprint, fingerprintFromPublicKey(info.publicKey));
    assert.ok(!JSON.stringify(info).includes(PRIVATE_SENTINEL));
    assert.ok(!JSON.stringify(info).includes('BEGIN OPENSSH PRIVATE KEY'));
    assert.equal(tools.calls.filter(call => path.basename(call.file) === 'ssh-keygen' && !call.args.includes('-lf')).length, 1);
    const again = await ensureInstallKey({ runtimeDir: box.root, installId: INSTALL_ID, exec: tools.exec });
    assert.equal(again.fingerprint, info.fingerprint);
    assert.equal(tools.calls.filter(call => path.basename(call.file) === 'ssh-keygen' && !call.args.includes('-lf')).length, 1);
    assert.equal(publicKey({ runtimeDir: box.root }), info.publicKey);
    assert.equal(fingerprint({ runtimeDir: box.root }), info.fingerprint);
    assert.equal(JSON.stringify(info).includes(box.root), false);
  } finally {
    box.cleanup();
  }
});

test('createHostKey and rotation plan expose public material only', async () => {
  const box = sandbox();
  try {
    const tools = fakeTools();
    const info = await createHostKey({ runtimeDir: box.root, hostId: 'build-01', installId: INSTALL_ID, exec: tools.exec });
    assert.deepEqual(info.keyRef, { file: 'ssh/keys/orbit-host-build-01' });
    assert.equal(mode(path.join(box.root, 'ssh', 'keys', 'orbit-host-build-01')), 0o600);
    assert.ok(!JSON.stringify(info).includes(PRIVATE_SENTINEL));
    assert.equal(tools.calls[0].args.includes('-f'), true);
    assert.equal(rotatePlan({ createdAt: '2026-09-01T00:00:00Z', rotationDays: 90, now: '2026-11-12T00:00:00Z' }).due, false);
    const due = rotatePlan({ createdAt: '2026-01-01T00:00:00Z', rotationDays: 90, now: '2026-11-12T00:00:00Z' });
    assert.equal(due.due, true);
    assert.ok(due.ageDays > 90);
    assert.match(due.rotateBy, /^2026-/);
  } finally {
    box.cleanup();
  }
});

test('renderSshConfig emits every hardening option, safe transports and owner-only files', () => {
  const box = sandbox();
  try {
    const hosts = [
      hostInput(),
      hostInput({ id: 'jump-01', address: '203.0.113.11', roles: ['infra'] }),
      hostInput({ id: 'edge-01', address: '203.0.113.12', transport: { kind: 'cloudflare', jumpHostId: null, tailcatAddrRef: null, cloudflareHostname: 'edge.example.test' } }),
      hostInput({ id: 'worker-01', address: 'worker-01.example.test', transport: { kind: 'tailscale', jumpHostId: null, tailcatAddrRef: null, cloudflareHostname: null } }),
      hostInput({ id: 'jump-02', address: '203.0.113.13', transport: { kind: 'proxyJump', jumpHostId: 'jump-01', tailcatAddrRef: null, cloudflareHostname: null } }),
      hostInput({ id: 'tail-01', address: '203.0.113.14', transport: { kind: 'tailcat', jumpHostId: null, tailcatAddrRef: { file: 'ssh/tailcat/tail-01' }, cloudflareHostname: null } }),
    ];
    const tailDir = path.join(box.root, 'ssh', 'tailcat');
    fs.mkdirSync(tailDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tailDir, 'tail-01'), 'tc-test-bearer-address\n', { mode: 0o600 });
    const text = renderSshConfig(hosts, { runtimeDir: box.root });
    assert.match(text, /^Host orbit-build-01$/m);
    assert.match(text, /HostKeyAlias orbit-build-01/);
    assert.match(text, /HostName 203\.0\.113\.10/);
    assert.match(text, /User orbit/);
    assert.match(text, /Port 22/);
    assert.match(text, /IdentitiesOnly yes/);
    assert.match(text, /BatchMode yes/);
    assert.match(text, /StrictHostKeyChecking yes/);
    assert.match(text, new RegExp(`UserKnownHostsFile ${box.root}/ssh/known_hosts`));
    assert.match(text, /GlobalKnownHostsFile \/dev\/null/);
    assert.match(text, /ForwardAgent no/);
    assert.match(text, /ControlMaster auto/);
    assert.match(text, /ControlPath .*\/ssh\/cm\/%C/);
    assert.match(text, /ControlPersist 10m/);
    assert.match(text, /ServerAliveInterval 15/);
    assert.match(text, /ConnectTimeout 10/);
    assert.match(text, /ProxyJump orbit-jump-01/);
    assert.match(text, /ProxyCommand cloudflared access ssh --hostname %h/);
    assert.match(text, /ProxyCommand tailcat .*tc-test-bearer-address/);
    assert.match(text, /tailcat.*UNTESTED/i);
    assert.doesNotMatch(text, /StrictHostKeyChecking (no|accept-new|ask)/i);
    assert.doesNotMatch(text, /ForwardAgent yes/);
    assert.ok(!text.includes(PRIVATE_SENTINEL));
    assert.ok(!text.includes('BEGIN OPENSSH PRIVATE KEY'));

    const configFile = writeSshConfig(hosts, { runtimeDir: box.root });
    assert.equal(configFile, path.join(box.root, 'ssh', 'config'));
    assert.equal(mode(configFile), 0o600);
    assert.equal(mode(path.join(box.root, 'ssh')), 0o700);
    assert.equal(mode(path.join(box.root, 'ssh', 'cm')), 0o700);
    assert.deepEqual(fs.readdirSync(path.join(box.root, 'ssh')).filter(name => name.includes('.tmp')), []);
    assert.throws(() => renderSshConfig([hostInput({ id: 'bad\nHost evil' })], { runtimeDir: box.root }));
    assert.throws(() => renderSshConfig([hostInput({ id: 'jump-02', transport: { kind: 'proxyJump', jumpHostId: 'missing' } })], { runtimeDir: box.root }));
  } finally {
    box.cleanup();
  }
});

test('importFromSshConfig resolves aliases with ssh -G and never executes pasted commands', async () => {
  const box = sandbox();
  try {
    const calls = [];
    const exec = async (file, args) => {
      calls.push({ file, args: [...args] });
      const fileIdx = args.indexOf('-F');
      const pasted = fs.readFileSync(args[fileIdx + 1], 'utf8');
      assert.doesNotMatch(pasted, /^Match/m);
      assert.doesNotMatch(pasted, /ProxyCommand/m);
      assert.doesNotMatch(pasted, /LocalCommand/m);
      assert.doesNotMatch(pasted, /Include/m);
      const alias = args.at(-1);
      if (alias === 'build') return { stdout: 'host build\nhostname 203.0.113.10\nuser deploy\nport 2222\nproxyjump jump\nidentityfile /tmp/id_ed25519\n', stderr: '' };
      return { stdout: 'host jump\nhostname 203.0.113.11\nuser orbit\nport 22\nidentityfile /tmp/id_ed25519\n', stderr: '' };
    };
    const { hosts } = makeHosts(box, { exec, calls });
    const imported = await hosts.importFromSshConfig([
      'Host build',
      '  HostName 203.0.113.10',
      '  User deploy',
      '  Port 2222',
      '  ProxyJump jump',
      '  IdentityFile /tmp/id_ed25519',
      '',
      'Host jump',
      '  HostName 203.0.113.11',
      '  Match exec "touch /tmp/should-not-run"',
      '  ProxyCommand curl evil',
      '  Include ~/.ssh/other',
    ].join('\n'));
    assert.equal(imported.length, 2);
    assert.deepEqual(imported[0], {
      alias: 'build',
      hostName: '203.0.113.10',
      user: 'deploy',
      port: 2222,
      proxyJump: 'jump',
      identityFile: '/tmp/id_ed25519',
    });
    assert.equal(imported[1].hostName, '203.0.113.11');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args.includes('-G'), true);
    assert.equal(calls[0].args.includes('-F'), true);
    assert.ok(!JSON.stringify(imported).includes(PRIVATE_SENTINEL));
  } finally {
    box.cleanup();
  }
});

test('config schema fragment rejects embedded secrets and unknown private fields', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../config/orbit-config.hosts.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  for (const definition of ['host', 'transport', 'auth', 'ssh', 'status', 'privilege', 'permissions', 'fileRef']) {
    assert.equal(schema.$defs[definition].additionalProperties, false, `${definition} must reject unknown fields`);
  }
  assert.deepEqual(Object.keys(schema.$defs.fileRef.properties), ['file']);
  const forbidden = /private|secret|passphrase|password|tailcatAddress/i;
  for (const [name, definition] of Object.entries(schema.$defs)) {
    for (const property of Object.keys(definition.properties || {})) {
      assert.doesNotMatch(property, forbidden, `${name}.${property} must not be configurable`);
    }
  }
  const hostProperties = new Set(Object.keys(schema.$defs.host.properties));
  const validHost = hostInput();
  assert.deepEqual(Object.keys(validHost).filter(key => !hostProperties.has(key)), []);
  const rejected = [
    { ...validHost, privateKey: 'SECRET' },
    { ...validHost, auth: { kind: 'orbit-key', keyId: 'orbit-default', privateKey: 'SECRET' } },
  ];
  for (const bad of rejected) {
    assert.ok(Object.keys(bad.auth || {}).some(key => !Object.keys(schema.$defs.auth.properties).includes(key)) || Object.keys(bad).some(key => !hostProperties.has(key)));
  }
  assert.ok(Object.keys(validHost.auth).every(key => Object.hasOwn(schema.$defs.auth.properties, key)));
  const defaultKeyProperties = new Set(Object.keys(schema.$defs.ssh.properties.defaultKey.properties));
  assert.equal(defaultKeyProperties.has('privateKey'), false);
  assert.equal(schema.$defs.ssh.properties.defaultKey.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.$defs.transport.properties, 'tailcatAddress'), false);
});

test('docker group privilege is refused unless it is acknowledged as root-equivalent', async () => {
  const box = sandbox();
  try {
    const tools = fakeTools();
    const { hosts } = makeHosts(box, tools);
    await assert.rejects(
      () => hosts.add(hostInput({ id: 'docker-01', address: '203.0.113.40', privilege: { sudo: 'none', docker: 'group', forcedCommand: false, terminal: false } })),
      /root-equivalent/,
    );
    const acknowledged = await hosts.add(hostInput({ id: 'docker-02', address: '203.0.113.41', privilege: { sudo: 'none', docker: 'group', dockerGroupRootEquivalent: true, forcedCommand: false, terminal: false } }));
    assert.equal(acknowledged.privilege.docker, 'group');
    assert.equal(acknowledged.privilege.dockerGroupRootEquivalent, true);
    const rootless = await hosts.add(hostInput({ id: 'docker-03', address: '203.0.113.42', privilege: { sudo: 'none', docker: 'rootless', forcedCommand: false, terminal: false } }));
    assert.equal(Object.hasOwn(rootless.privilege, 'dockerGroupRootEquivalent'), false);
  } finally {
    box.cleanup();
  }
});

test('host permissions default to none for every agent and accept validated dynamic agent ids', async () => {
  const box = sandbox();
  try {
    const tools = fakeTools();
    const { hosts } = makeHosts(box, tools);
    const defaults = await hosts.add(hostInput({ id: 'defaults-01', address: '203.0.113.30', permissions: undefined }));
    assert.deepEqual(defaults.permissions, {
      setup: 'none',
      pi: 'none',
      opencode: 'none',
      hermes: 'none',
      bundlebees: 'none',
    });

    const dynamic = await hosts.add(hostInput({
      id: 'dynamic-01',
      address: '203.0.113.31',
      permissions: { 'openai-compatible': 'read', 'my-agent-2': 'deploy' },
    }));
    assert.equal(dynamic.permissions['openai-compatible'], 'read');
    assert.equal(dynamic.permissions['my-agent-2'], 'deploy');
    assert.equal(dynamic.permissions.setup, 'none');
    assert.equal(dynamic.permissions.bundlebees, 'none');

    const invalidIds = ['Bad', '_bad', 'a'.repeat(33), 'bad_id', 'bad agent', ''];
    for (const [index, agent] of invalidIds.entries()) {
      await assert.rejects(
        () => hosts.add(hostInput({ id: `invalid-${index}`, address: '203.0.113.32', permissions: { [agent]: 'read' } })),
        /agent|permission/i,
      );
    }

    const tooMany = {};
    for (let index = 0; index < 33; index += 1) tooMany[`agent-${index}`] = 'read';
    await assert.rejects(
      () => hosts.add(hostInput({ id: 'many-01', address: '203.0.113.33', permissions: tooMany })),
      /32|too many|permission/i,
    );
  } finally {
    box.cleanup();
  }
});

test('bootstrapScript is inlined, idempotent and prints the host fingerprint', () => {
  assert.throws(
    () => bootstrapScript({ publicKey: `${TEST_PUB} orbit-${INSTALL_ID}`, installId: INSTALL_ID, docker: 'group', sudo: 'none' }),
    /root-equivalent|acknowledge/i,
  );
  const script = bootstrapScript({ publicKey: `${TEST_PUB} orbit-${INSTALL_ID}`, installId: INSTALL_ID, docker: 'group', sudo: 'scoped', dockerGroupRootEquivalent: true });
  assert.match(script, /#!\/bin\/sh/);
  assert.match(script, /set -eu/);
  assert.match(script, /useradd/);
  assert.match(script, /authorized_keys/);
  assert.match(script, /restrict,pty/);
  assert.match(script, new RegExp(`orbit-${INSTALL_ID}`));
  assert.match(script, /grep -q/);
  assert.match(script, /umask 077/);
  assert.match(script, /visudo -cf/);
  assert.match(script, /\/etc\/sudoers\.d\/orbit/);
  assert.match(script, /ssh-keygen -lf \/etc\/ssh\/ssh_host_ed25519_key\.pub/);
  assert.match(script, /usermod -aG docker orbit/);
  assert.match(script, /root-equivalent/i);
  assert.doesNotMatch(script, /\b(curl|wget)\b/);
  assert.doesNotMatch(script, /StrictHostKeyChecking/);
  const none = bootstrapScript({ publicKey: `${TEST_PUB} orbit-${INSTALL_ID}`, installId: INSTALL_ID, docker: 'none', sudo: 'none' });
  assert.doesNotMatch(none, /sudoers\.d\/orbit/);
  assert.doesNotMatch(none, /usermod -aG docker/);
  const rootless = bootstrapScript({ publicKey: `${TEST_PUB} orbit-${INSTALL_ID}`, installId: INSTALL_ID, docker: 'rootless', sudo: 'none' });
  assert.match(rootless, /rootless/i);
  const line = oneLiner(script);
  assert.match(line, /^sudo /);
  const encoded = line.match(/'([A-Za-z0-9+/=]+)'/)[1];
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), script);
  assert.throws(() => bootstrapScript({ publicKey: 'not-a-key', installId: INSTALL_ID, docker: 'none', sudo: 'none' }));
  assert.throws(() => bootstrapScript({ publicKey: `${TEST_PUB} orbit-x`, installId: 'bad id', docker: 'none', sudo: 'none' }));
});

test('add, scan, confirm and test keep private keys out of every result, log and audit file', async () => {
  const box = sandbox();
  try {
    const tools = fakeTools();
    const { hosts, config, logs } = makeHosts(box, tools);
    const added = await hosts.add(hostInput());
    assert.equal(added.id, 'build-01');
    assert.equal(added.status.state, 'unreachable');
    assert.equal(config.components.hosts, true);
    assert.equal(config.hosts.length, 1);
    assert.equal(config.ssh.defaultKey.publicKey.endsWith(`orbit-${INSTALL_ID}`), true);
    assert.ok(!JSON.stringify(config).includes(PRIVATE_SENTINEL));
    assert.ok(!JSON.stringify(added).includes(PRIVATE_SENTINEL));
    assert.equal(fs.existsSync(path.join(box.root, 'ssh', 'config')), true);

    const scanned = await hosts.scanHostKey('build-01');
    assert.equal(scanned.fingerprint, fingerprintFromPublicKey(TEST_PUB));
    assert.equal(scanned.algorithm, 'ssh-ed25519');
    await assert.rejects(() => hosts.confirmPin('build-01', 'SHA256:wrong'), /fingerprint/i);
    const pinned = await hosts.confirmPin('build-01', scanned.fingerprint);
    assert.equal(pinned.status.state, 'verified');
    assert.deepEqual(pinned.hostKey.fingerprints, [scanned.fingerprint]);
    const known = fs.readFileSync(path.join(box.root, 'ssh', 'known_hosts'), 'utf8');
    assert.ok(known.split('\n').includes(`orbit-build-01 ssh-ed25519 ${TEST_B64}`));
    assert.equal(mode(path.join(box.root, 'ssh', 'known_hosts')), 0o600);

    const tested = await hosts.test('build-01');
    assert.equal(tested.ok, true);
    assert.equal(tested.preflight.arch, 'x86_64');
    assert.match(tested.preflight.docker, /Docker version/);
    assert.match(tested.preflight.compose, /Docker Compose/);
    assert.match(tested.preflight.sudo, /systemctl/);
    assert.equal(hosts.status('build-01').status.state, 'verified');

    const audit = fs.readFileSync(path.join(box.root, 'audit', 'hosts', 'build-01.jsonl'), 'utf8');
    const everything = JSON.stringify({ config, added, pinned, tested, logs, audit });
    assert.ok(!everything.includes(PRIVATE_SENTINEL));
    assert.ok(!everything.includes('BEGIN OPENSSH PRIVATE KEY'));
  } finally {
    box.cleanup();
  }
});

test('non-default ports pin the bare HostKeyAlias (OpenSSH ignores the port with an alias) and revoke removes it', async () => {
  const box = sandbox();
  try {
    const tools = fakeTools();
    const { hosts } = makeHosts(box, tools);
    await hosts.add(hostInput({ id: 'port-01', address: '203.0.113.20', port: 2222 }));
    const scanned = await hosts.scanHostKey('port-01');
    await hosts.confirmPin('port-01', scanned.fingerprint);
    const known = fs.readFileSync(path.join(box.root, 'ssh', 'known_hosts'), 'utf8').split('\n');
    assert.ok(known.includes(`orbit-port-01 ssh-ed25519 ${TEST_B64}`));
    assert.ok(!known.some(line => line.startsWith('[orbit-port-01]')));
    await hosts.revoke('port-01');
    assert.doesNotMatch(fs.readFileSync(path.join(box.root, 'ssh', 'known_hosts'), 'utf8'), /orbit-port-01/);
  } finally {
    box.cleanup();
  }
});

test('key changes are detected, block actions, and revoke removes local access only', async () => {
  const box = sandbox();
  try {
    const tools = fakeTools();
    const { hosts, config } = makeHosts(box, tools);
    await hosts.add(hostInput({ auth: { kind: 'host-key', keyId: 'orbit-host-build-01' } }));
    assert.equal(fs.existsSync(path.join(box.root, 'ssh', 'keys', 'orbit-host-build-01')), true);
    const scanned = await hosts.scanHostKey('build-01');
    await hosts.confirmPin('build-01', scanned.fingerprint);
    assert.equal(isHostKeyChanged('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'), true);
    assert.equal(isHostKeyChanged('Host key verification failed.'), true);
    assert.equal(isHostKeyChanged('Connection refused'), false);
    assert.equal(isHostKeyChanged('No ED25519 host key is known for host'), false);

    const failing = fakeTools({ fail: (base, args) => base === 'ssh' && args.includes('true') });
    const changed = createSshHosts({ runtimeDir: box.root, config, exec: async (file, args, options) => {
      if (path.basename(file) === 'ssh' && args.includes('true')) throw Object.assign(new Error('changed'), { stderr: 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', code: 255 });
      return failing.exec(file, args, options);
    } });
    const blocked = await changed.test('build-01');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'key-changed');
    assert.equal(changed.status('build-01').status.state, 'key-changed');
    const refused = await changed.test('build-01');
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'key-changed');

    const revoked = await hosts.revoke('build-01');
    assert.equal(revoked.state, 'revoked');
    assert.match(revoked.authorizedKeysLine, /^restrict,pty ssh-ed25519 /);
    assert.match(revoked.authorizedKeysLine, new RegExp(`orbit-${INSTALL_ID}$`));
    assert.equal(fs.existsSync(path.join(box.root, 'ssh', 'keys', 'orbit-host-build-01')), false);
    assert.doesNotMatch(fs.readFileSync(path.join(box.root, 'ssh', 'known_hosts'), 'utf8'), /orbit-build-01/);
    assert.equal(fs.existsSync(path.join(box.root, 'audit', 'hosts', 'build-01.jsonl')), true);
    const after = await hosts.test('build-01');
    assert.equal(after.ok, false);
    assert.equal(after.reason, 'revoked');
    assert.ok(!JSON.stringify({ revoked, after }).includes(PRIVATE_SENTINEL));
  } finally {
    box.cleanup();
  }
});

test('remove with cleanup runs the marked authorization cleanup before local revoke', async () => {
  const box = sandbox();
  try {
    const tools = fakeTools();
    const { hosts, config } = makeHosts(box, tools);
    await hosts.add(hostInput());
    const scanned = await hosts.scanHostKey('build-01');
    await hosts.confirmPin('build-01', scanned.fingerprint);
    const removed = await hosts.remove('build-01', { cleanup: true });
    assert.equal(removed.removed, true);
    assert.equal(removed.cleanup.attempted, true);
    assert.equal(removed.cleanup.ok, true);
    assert.match(removed.authorizedKeysLine, new RegExp(`orbit-${INSTALL_ID}`));
    const cleanupCall = tools.calls.find(call => {
      if (path.basename(call.file) !== 'ssh') return false;
      const idx = call.args.findIndex(arg => arg === '-F');
      return idx >= 0 && call.args.includes('sh') && call.args.includes('-c');
    });
    assert.ok(cleanupCall, 'remote cleanup command was not run');
    assert.match(cleanupCall.args.at(-1), new RegExp(`orbit-${INSTALL_ID}`));
    assert.match(cleanupCall.args.at(-1), /authorized_keys/);
    assert.equal(config.hosts[0].status.state, 'revoked');
    assert.ok(!JSON.stringify(removed).includes(PRIVATE_SENTINEL));
  } finally {
    box.cleanup();
  }
});

test('add rejects secret-bearing and malformed host objects without echoing values', async () => {
  const box = sandbox();
  try {
    const tools = fakeTools();
    const { hosts } = makeHosts(box, tools);
    const tailcatDir = path.join(box.root, 'ssh', 'tailcat');
    fs.mkdirSync(tailcatDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tailcatDir, 'bad'), 'tc;touch /tmp/orbit-should-not-run\n', { mode: 0o600 });
    const cases = [
      { ...hostInput({ id: 'x1' }), privateKey: 'SECRET-MATERIAL' },
      { ...hostInput({ id: 'x2' }), auth: { kind: 'orbit-key', keyId: 'orbit-default', privateKey: 'SECRET-MATERIAL' } },
      hostInput({ id: '../escape' }),
      hostInput({ id: 'x3', address: '203.0.113.10\nInclude /tmp/x' }),
      hostInput({ id: 'x4', transport: { kind: 'tailcat', tailcatAddrRef: { file: '../../etc/passwd' } } }),
      hostInput({ id: 'x5', transport: { kind: 'tailcat', tailcatAddrRef: { file: 'ssh/tailcat/bad' } } }),
    ];
    for (const bad of cases) {
      await assert.rejects(async () => hosts.add(bad), error => !String(error.message).includes('SECRET-MATERIAL'));
    }
  } finally {
    box.cleanup();
  }
});
