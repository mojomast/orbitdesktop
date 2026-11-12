import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGithubConnection } from '../server/onboarding-github.mjs';

const TOKEN = 'ghp_SENTINELsentinelSENTINEL0123456789'; // gitleaks:allow (fake test token)
const DEVICE_TOKEN = 'gho_DEVICEsentinelDEVICE0123456789abc'; // gitleaks:allow (fake test token)

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-github-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function reply(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) };
}

/** A fake GitHub. Records every call with the authorization it carried. */
function fakeGithub({ validToken = TOKEN, repos = [{ full_name: 'octo/one', private: false }, { full_name: 'octo/two', private: true }], device = true } = {}) {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? '';
    calls.push({ url: u.href, method: init.method ?? 'GET', auth: auth ? 'set' : '', body: init.body ?? '' });
    if (u.pathname === '/user') {
      if (auth === `Bearer ${validToken}` || auth === `Bearer ${DEVICE_TOKEN}`) return reply(200, { login: 'octocat' }, { 'x-oauth-scopes': 'repo, read:org' });
      return reply(401, { message: `Bad credentials for ${auth}` });
    }
    if (u.pathname === '/user/repos') {
      if (!auth) return reply(401, {});
      return reply(200, repos);
    }
    if (u.pathname === '/login/device/code' && device) return reply(200, { device_code: 'DEVICE-CODE-SECRET', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 0, expires_in: 900 });
    if (u.pathname === '/login/oauth/access_token') {
      polls += 1;
      if (polls < 2) return reply(200, { error: 'authorization_pending' });
      return reply(200, { access_token: DEVICE_TOKEN, token_type: 'bearer', scope: 'repo' });
    }
    return reply(404, {});
  };
  return { fetchImpl, calls };
}

function noLeak(value, ...secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `leaked ${secret.slice(0, 6)}…`);
}

test('starts disconnected and skipping makes no network call', async t => {
  const gh = fakeGithub();
  const conn = createGithubConnection({ runtimeDir: tmp(t), fetchImpl: gh.fetchImpl, env: {} });
  assert.deepEqual(await conn.status(), { ok: true, connected: false, login: null, method: null, scopes: [], connectedAt: null, deviceFlow: false });
  assert.equal(gh.calls.length, 0);
});

test('a pasted token is verified, stored 0600 and never echoed or logged', async t => {
  const runtimeDir = tmp(t);
  const logs = [];
  const gh = fakeGithub();
  const conn = createGithubConnection({ runtimeDir, fetchImpl: gh.fetchImpl, env: {}, log: line => logs.push(line) });
  const connected = await conn.connectToken(TOKEN);
  assert.equal(connected.connected, true);
  assert.equal(connected.login, 'octocat');
  assert.equal(connected.method, 'token');
  assert.deepEqual(connected.scopes, ['repo', 'read:org']);
  const tokenFile = path.join(runtimeDir, 'github', 'token');
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), TOKEN);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(runtimeDir, 'github')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(runtimeDir, 'github', 'account.json')).mode & 0o777, 0o600);
  noLeak(fs.readFileSync(path.join(runtimeDir, 'github', 'account.json'), 'utf8'), TOKEN);
  noLeak(connected, TOKEN);
  noLeak(await conn.status(), TOKEN);
  noLeak(logs.join('\n'), TOKEN);
});

test('a rejected token is not stored and the error does not echo it', async t => {
  const runtimeDir = tmp(t);
  const conn = createGithubConnection({ runtimeDir, fetchImpl: fakeGithub({ validToken: 'something-else-entirely-000' }).fetchImpl, env: {} });
  await assert.rejects(conn.connectToken(TOKEN), error => {
    assert.equal(error.status, 400);
    noLeak(error.message, TOKEN);
    return /GitHub did not accept/.test(error.message);
  });
  assert.equal(fs.existsSync(path.join(runtimeDir, 'github', 'token')), false);
  assert.equal((await conn.status()).connected, false);
});

test('malformed tokens are refused before any network call', async t => {
  const gh = fakeGithub();
  const conn = createGithubConnection({ runtimeDir: tmp(t), fetchImpl: gh.fetchImpl, env: {} });
  for (const bad of ['', 'short', 'has space in the middle of it xx', `${TOKEN}\n`, 'x'.repeat(256), 42, null]) {
    await assert.rejects(conn.connectToken(bad), error => error.status === 400);
  }
  assert.equal(gh.calls.length, 0);
});

test('disconnect removes the token and account files', async t => {
  const runtimeDir = tmp(t);
  const conn = createGithubConnection({ runtimeDir, fetchImpl: fakeGithub().fetchImpl, env: {} });
  await conn.connectToken(TOKEN);
  const result = await conn.disconnect();
  assert.equal(result.connected, false);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'github', 'token')), false);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'github', 'account.json')), false);
  assert.equal((await conn.status()).connected, false);
  assert.equal((await conn.disconnect()).connected, false, 'disconnect is idempotent');
});

test('device flow is unavailable without a client id and says what to do instead', async t => {
  const gh = fakeGithub();
  const conn = createGithubConnection({ runtimeDir: tmp(t), fetchImpl: gh.fetchImpl, env: {} });
  await assert.rejects(conn.deviceStart(), error => error.status === 409 && /ORBIT_GITHUB_CLIENT_ID/.test(error.message) && /token/.test(error.message));
  assert.equal(gh.calls.length, 0);
});

test('device flow keeps the device code server-side and stores the token on success', async t => {
  const runtimeDir = tmp(t);
  const gh = fakeGithub();
  const conn = createGithubConnection({ runtimeDir, fetchImpl: gh.fetchImpl, env: { ORBIT_GITHUB_CLIENT_ID: 'Iv1.testclient' } });
  assert.equal((await conn.status()).deviceFlow, true);
  const started = await conn.deviceStart();
  assert.equal(started.userCode, 'ABCD-1234');
  assert.equal(started.verificationUri, 'https://github.com/login/device');
  assert.equal(typeof started.flowId, 'string');
  noLeak(started, 'DEVICE-CODE-SECRET');
  const pending = await conn.devicePoll(started.flowId);
  assert.equal(pending.pending, true);
  const done = await conn.devicePoll(started.flowId);
  assert.equal(done.connected, true);
  assert.equal(done.method, 'device');
  noLeak(done, DEVICE_TOKEN, 'DEVICE-CODE-SECRET');
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'github', 'token'), 'utf8'), DEVICE_TOKEN);
  await assert.rejects(conn.devicePoll(started.flowId), error => error.status === 404, 'a finished flow cannot be replayed');
  await assert.rejects(conn.devicePoll('unknown'), error => error.status === 404);
});

test('repositories are listed by name only, and only when connected', async t => {
  const conn = createGithubConnection({ runtimeDir: tmp(t), fetchImpl: fakeGithub().fetchImpl, env: {} });
  await assert.rejects(conn.listRepos(), error => error.status === 409);
  await conn.connectToken(TOKEN);
  const listed = await conn.listRepos();
  assert.deepEqual(listed.repos, [{ fullName: 'octo/one', private: false }, { fullName: 'octo/two', private: true }]);
  noLeak(listed, TOKEN);
});

test('only https or loopback http API bases are accepted', async t => {
  const runtimeDir = tmp(t);
  assert.throws(() => createGithubConnection({ runtimeDir, env: { ORBIT_GITHUB_API: 'http://evil.example' } }), /https/);
  assert.throws(() => createGithubConnection({ runtimeDir, env: { ORBIT_GITHUB_WEB: 'file:///etc' } }), /https/);
  assert.doesNotThrow(() => createGithubConnection({ runtimeDir, env: { ORBIT_GITHUB_API: 'http://127.0.0.1:9999', ORBIT_GITHUB_WEB: 'https://ghe.example.com' } }));
});
