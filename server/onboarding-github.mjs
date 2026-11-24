// Optional GitHub connection for onboarding and Settings.
//
// The token lives only in <runtime>/github/token (0600, directory 0700). It is
// never written to orbit-config.json, never returned by any route and never
// logged. GitHub error bodies are not passed through: they can echo request
// data. See docs/ONBOARDING-GITHUB.md for the acceptance criteria.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TOKEN_PATTERN = /^[\x21-\x7e]{20,255}$/;
const DEVICE_TTL_MS = 15 * 60 * 1000;
const MAX_FLOWS = 4;
const REQUEST_TIMEOUT_MS = 15_000;

function statusError(message, status) {
  return Object.assign(Error(message), { status });
}

function checkedBase(raw, fallback, name) {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim().replace(/\/+$/, '') : fallback;
  let url;
  try { url = new URL(value); } catch { throw Error(`${name} must be an https URL.`); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw Error(`${name} must be an https URL (http is allowed only on loopback).`);
  return value;
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(path.dirname(file)).isDirectory()) throw Error('Unsafe GitHub storage.');
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function createGithubConnection({ runtimeDir, fetchImpl = fetch, env = process.env, log = () => {}, now = () => Date.now() } = {}) {
  if (typeof runtimeDir !== 'string' || !runtimeDir) throw Error('The GitHub connection needs a runtime directory.');
  const apiBase = checkedBase(env.ORBIT_GITHUB_API, 'https://api.github.com', 'ORBIT_GITHUB_API');
  const webBase = checkedBase(env.ORBIT_GITHUB_WEB, 'https://github.com', 'ORBIT_GITHUB_WEB');
  const clientId = typeof env.ORBIT_GITHUB_CLIENT_ID === 'string' && /^[A-Za-z0-9._-]{4,100}$/.test(env.ORBIT_GITHUB_CLIENT_ID) ? env.ORBIT_GITHUB_CLIENT_ID : '';
  const dir = path.join(runtimeDir, 'github');
  const tokenFile = path.join(dir, 'token');
  const flows = new Map();
  let generation = 0;

  function safeLog(message) {
    try { log(String(message).slice(0, 200)); } catch { /* logging never changes the outcome */ }
  }

  async function call(url, init = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' });
    } catch {
      throw statusError('GitHub could not be reached. Check the endpoint and try again.', 503);
    }
    if (response.status === 429 || (response.status === 403 && (response.headers?.get?.('x-ratelimit-remaining') === '0' || response.headers?.get?.('retry-after')))) throw statusError('GitHub rate limit reached. Wait before trying again.', 429);
    return response;
  }

  function stored() {
    try {
      const folder = fs.lstatSync(dir), info = fs.lstatSync(tokenFile);
      if (!folder.isDirectory() || !info.isFile() || (folder.mode & 0o077) || (info.mode & 0o077) || info.size > 255 || info.size < 20) throw Error('Unsafe GitHub storage.');
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw statusError('Unsafe GitHub credential storage. Check the private runtime directory.', 409); }
  }

  function view() {
    return {
      ok: true,
      connected: stored(),
      deviceFlow: Boolean(clientId),
    };
  }

  async function verify(token) {
    const response = await call(`${apiBase}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'orbit-desktop' },
    });
    if (response.status === 401 || response.status === 403) throw statusError('GitHub did not accept that token. Check that it is current and has repository read access.', 400);
    if (!response.ok) throw statusError('GitHub could not verify the token right now.', 502);
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    const login = typeof body?.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(body.login) ? body.login : null;
    if (!login) throw statusError('GitHub returned an unexpected account.', 502);
  }

  async function store(token, version) {
    await verify(token);
    if (generation !== version) throw statusError('Sign-in cancelled. Start again.', 409);
    writePrivate(tokenFile, token);
    safeLog('GitHub connected.');
    return view();
  }

  async function connectToken(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw statusError('Paste a GitHub token: 20 to 255 characters with no spaces.', 400);
    disconnect();
    return store(token, generation);
  }

  function disconnect() {
    generation++;
    flows.clear();
    if (fs.existsSync(dir) && !fs.lstatSync(dir).isDirectory()) throw statusError('Unsafe GitHub storage. Check the runtime directory.', 409);
    fs.rmSync(tokenFile, { force: true });
    safeLog('GitHub disconnected.');
    return { ...view(), revokeUrl: `${webBase}/settings/tokens` };
  }

  function prune() {
    for (const [id, flow] of flows) if (flow.expiresAt <= now()) flows.delete(id);
  }

  async function deviceStart() {
    if (!clientId) throw statusError('Device sign-in needs a GitHub OAuth app client id in ORBIT_GITHUB_CLIENT_ID. Paste a token instead.', 409);
    const version = generation;
    if (stored()) throw statusError('Disconnect before starting a new sign-in.', 409);
    prune();
    if (flows.size >= MAX_FLOWS) throw statusError('Too many GitHub sign-ins are in progress. Wait a few minutes and try again.', 429);
    const response = await call(`${webBase}/login/device/code`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'orbit-desktop' },
      body: JSON.stringify({ client_id: clientId, scope: '' }),
    });
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') throw statusError('GitHub did not start device sign-in.', 502);
    const expiresIn = Math.min(Math.max(Number(body.expires_in) || 900, 60), 1800);
    const interval = Math.min(Math.max(Number(body.interval) || 5, 0), 60);
    const flowId = randomUUID();
    if (generation !== version) throw statusError('Sign-in cancelled. Start again.', 409);
    flows.set(flowId, { deviceCode: body.device_code, expiresAt: now() + Math.min(expiresIn * 1000, DEVICE_TTL_MS), interval, version });
    const verificationUri = `${webBase}/login/device`;
    return { ok: true, flowId, userCode: String(body.user_code).slice(0, 20), verificationUri, interval, expiresIn };
  }

  async function devicePoll(flowId) {
    prune();
    const flow = typeof flowId === 'string' ? flows.get(flowId) : undefined;
    if (!flow) throw statusError('That GitHub sign-in has finished or expired. Start again.', 404);
    const response = await call(`${webBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'orbit-desktop' },
      body: JSON.stringify({ client_id: clientId, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    if (body.error === 'slow_down') throw statusError('GitHub rate limit reached. Wait before checking the code again.', 429);
    if (body.error === 'authorization_pending') {
      return { ok: true, pending: true, interval: flow.interval };
    }
    if (typeof body.access_token !== 'string' || !TOKEN_PATTERN.test(body.access_token)) {
      flows.delete(flowId);
      const reason = body.error === 'expired_token' ? 'The code expired.' : body.error === 'access_denied' ? 'Sign-in was denied on GitHub.' : 'GitHub did not complete sign-in.';
      throw statusError(`${reason} Start again or paste a token.`, 400);
    }
    flows.delete(flowId);
    if (generation !== flow.version) throw statusError('Sign-in cancelled. Start again.', 409);
    flows.clear();
    return { ...(await store(body.access_token, ++generation)), pending: false };
  }

  async function listRepos() {
    if (!stored()) throw statusError('Connect GitHub to list your repositories, or type them in.', 409);
    const version = generation;
    const token = fs.readFileSync(tokenFile, 'utf8');
    const response = await call(`${apiBase}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'orbit-desktop' },
    });
    if (response.status === 401) throw statusError('GitHub no longer accepts the saved token. Disconnect and connect again.', 400);
    if (response.status === 403) throw statusError('Repository access denied. Check the token or enter names manually.', 403);
    if (!response.ok) throw statusError('GitHub could not list repositories right now.', 502);
    let rows = [];
    try { rows = await response.json(); } catch { throw statusError('GitHub returned an invalid list.', 502); }
    if (!Array.isArray(rows)) throw statusError('GitHub returned an invalid list.', 502);
    if (generation !== version) throw statusError('Sign-in changed. List repositories again.', 409);
    const repos = (Array.isArray(rows) ? rows : [])
      .filter(row => typeof row?.full_name === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(row.full_name))
      .slice(0, 100)
      .map(row => ({ fullName: row.full_name }));
    return { ok: true, repos };
  }

  /** Routes below /github: GET status, POST token, POST device/start, POST device/poll, POST|DELETE disconnect, GET repos. */
  async function route(method, parts, body) {
    if (parts.length === 0 && method === 'GET') return view();
    if (parts.length === 1 && parts[0] === 'token' && method === 'POST') return connectToken(body?.token);
    if (parts.length === 2 && parts[0] === 'device' && parts[1] === 'start' && method === 'POST') return deviceStart();
    if (parts.length === 2 && parts[0] === 'device' && parts[1] === 'poll' && method === 'POST') return devicePoll(body?.flowId);
    if (parts.length === 1 && parts[0] === 'disconnect' && (method === 'POST' || method === 'DELETE')) return disconnect();
    if (parts.length === 0 && method === 'DELETE') return disconnect();
    if (parts.length === 1 && parts[0] === 'repos' && method === 'GET') return listRepos();
    throw statusError('Not found.', 404);
  }

  return { status: async () => view(), connectToken, disconnect, deviceStart, devicePoll, listRepos, route, connected: stored };
}
