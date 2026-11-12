/**
 * Glue between the running Orbit server and the runnable-by-anyone modules:
 * orbit-config.json (server/orbit-config.mjs), the onboarding wizard and
 * Settings routes (server/onboarding.mjs, server/onboarding-apply.mjs), the
 * opt-in token router (server/router-supervisor.mjs), the setup agent
 * (server/setup-agent.mjs), SSH hosts (server/ssh-hosts.mjs, server/host-api.mjs,
 * server/host-audit.mjs) and the generic OpenAI-compatible adapter
 * (server/openai-compat-gateway.mjs).
 *
 * index.mjs owns authentication and calls `handle(req, res, url)` only for an
 * authenticated owner request under /api/onboarding, /api/settings or
 * /api/hosts. Nothing here logs request bodies, keys or provider responses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createOrbitConfig, normalizeRepoList, resolveRoles } from './orbit-config.mjs';
import { createGithubConnection } from './onboarding-github.mjs';
import { createOnboarding } from './onboarding.mjs';
import { createOnboardingApply } from './onboarding-apply.mjs';
import { createRouterSupervisor } from './router-supervisor.mjs';
import { setupAgentPrompt, setupChecklist } from './setup-agent.mjs';
import { createSshHosts } from './ssh-hosts.mjs';
import { createHostAudit } from './host-audit.mjs';
import { startOpenAICompatGateway } from './openai-compat-gateway.mjs';
import { agentProviderRegistry, registerGatewayProvider } from './agent-providers.mjs';

export const OPENAI_COMPAT_PROVIDER = 'openai-compatible';
const OPENAI_KINDS = new Set(['openai-compatible', 'openrouter', 'anthropic', 'router']);
const HOST_LEVELS = new Set(['none', 'read', 'deploy', 'admin']);
const MAX_BODY = 256 * 1024;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const part of req) {
    raw += part;
    if (raw.length > MAX_BODY) throw Object.assign(Error('Request too large.'), { status: 413 });
  }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(Error('Invalid JSON.'), { status: 400 }); }
}

function atomicPrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* mode set at open */ }
}

/** A key-free copy of a config view for the setup agent and its checklist. */
function keyFreeConfig(view) {
  const providers = (view.providers ?? []).map(({ key, keyRef, ...rest }) => ({ ...rest, keySet: Boolean(key?.set) }));
  return { ...view, providers, roles: resolveRoles(view) };
}

function hostIdFrom(text) {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug && /^[a-z0-9]/.test(slug) ? slug : `host-${randomBytes(3).toString('hex')}`;
}

export function createOrbitSetup({
  runtimeDir,
  env = process.env,
  discovered = {},
  log = () => {},
  routerExec,
  sshExec,
  startGateway = startOpenAICompatGateway,
  githubFetch = fetch,
  hasAgents = () => false,
} = {}) {
  const safeLog = message => { try { log(String(message).slice(0, 300)); } catch { /* logging never changes an outcome */ } };
  const store = createOrbitConfig({ runtimeDir, env });
  const runtime = store.runtimeDir;

  // The supervisor reads the CURRENT document on every call, and nothing is
  // started unless config.router.enabled (the onboarding module checks that
  // before it calls enable()).
  const liveConfig = {
    get router() { return store.load().router; },
    get roles() { return resolveRoles(store.load()); },
    get providers() { return store.load().providers; },
  };
  let supervisor = null;
  const routerSupervisor = new Proxy({}, {
    get(_target, name) {
      if (!supervisor) supervisor = createRouterSupervisor({ runtimeDir: runtime, config: liveConfig, ...(routerExec ? { exec: routerExec } : {}), log: safeLog });
      const value = supervisor[name];
      return typeof value === 'function' ? value.bind(supervisor) : value;
    },
  });

  const setupFile = path.join(runtime, 'setup-agent', 'request.json');
  async function startSetupAgent(view) {
    const config = keyFreeConfig(view);
    const setupRole = config.roles.setup;
    const provider = config.providers.find(item => item.id === setupRole?.provider);
    const request = {
      createdAt: new Date().toISOString(),
      agent: setupRole?.provider ? { provider: setupRole.provider, model: setupRole.model, label: provider?.label ?? setupRole.provider } : null,
      checklist: setupChecklist(config),
      prompt: setupAgentPrompt({ agentLabel: provider?.label, config }),
    };
    atomicPrivate(setupFile, `${JSON.stringify(request, null, 2)}\n`);
    safeLog('Setup agent request recorded.');
    return { recorded: true };
  }

  const onboarding = createOnboarding({ config: store, routerSupervisor, startSetupAgent, log: safeLog, env });
  const settings = createOnboardingApply({ config: store, startSetupAgent, log: safeLog, routerSupervisor });
  let github;
  try {
    github = createGithubConnection({ runtimeDir, env, log: safeLog, fetchImpl: githubFetch });
  } catch {
    safeLog('Ignoring an invalid ORBIT_GITHUB_API or ORBIT_GITHUB_WEB; using github.com.');
    github = createGithubConnection({ runtimeDir, env: { ORBIT_GITHUB_CLIENT_ID: env?.ORBIT_GITHUB_CLIENT_ID }, log: safeLog, fetchImpl: githubFetch });
  }

  function reposView() {
    return { ok: true, repos: store.load().observability?.repos ?? [], githubConnected: github.connected() };
  }

  async function putRepos(body) {
    const repos = normalizeRepoList(body?.repos);
    const current = store.load();
    store.save({ ...current, observability: { ...(current.observability ?? {}), repos } });
    safeLog(`Saved ${repos.length} watched repositories.`);
    return reposView();
  }

  /** GitHub and repo routes, shared by /api/onboarding/* and /api/settings/*. */
  async function githubAndRepos(req, res, rest) {
    const method = String(req.method || 'GET').toUpperCase();
    const parts = rest.split('/').filter(Boolean);
    if (parts[0] === 'repos' && parts.length === 1) {
      if (method === 'GET') return json(res, 200, reposView()), true;
      if (method === 'PUT' || method === 'POST') return json(res, 200, await putRepos(await readJson(req))), true;
      return json(res, 405, { ok: false, error: 'Method not allowed.' }), true;
    }
    if (parts[0] === 'github') {
      const body = ['POST', 'PUT'].includes(method) ? await readJson(req) : {};
      return json(res, 200, await github.route(method, parts.slice(1), body)), true;
    }
    return false;
  }

  // Hosts live in their own private document: orbit-config.json has a closed
  // schema and never carries host material.
  const hostsFile = path.join(runtime, 'orbit-hosts.json');
  let hostsConfig;
  try { hostsConfig = JSON.parse(fs.readFileSync(hostsFile, 'utf8')); } catch { hostsConfig = {}; }
  if (!hostsConfig || typeof hostsConfig !== 'object' || Array.isArray(hostsConfig)) hostsConfig = {};
  if (!Array.isArray(hostsConfig.hosts)) hostsConfig.hosts = [];
  const saveHosts = value => atomicPrivate(hostsFile, `${JSON.stringify(value, null, 2)}\n`);
  let sshHosts = null;
  let audit = null;
  const hosts = () => (sshHosts ??= createSshHosts({ runtimeDir: runtime, config: hostsConfig, ...(sshExec ? { exec: sshExec } : {}), log: safeLog, saveConfig: saveHosts }));
  const hostAudit = () => (audit ??= createHostAudit({ runtimeDir: runtime }));

  async function hostAction(body) {
    const api = hosts();
    switch (body?.action) {
      case 'list': return { ok: true, hosts: api.list(), installId: api.installId() };
      case 'add': {
        const transport = body.transport && typeof body.transport === 'object' ? body.transport : {};
        if (transport.kind === 'tailcat') throw Object.assign(Error('The tailcat transport is untested; add it in orbit-hosts.json by hand if you need it.'), { status: 400 });
        const parsed = (await import('./ssh-hosts.mjs')).parseAddress(String(body.address ?? ''));
        const input = {
          id: hostIdFrom(body.label || parsed.host),
          label: String(body.label || parsed.host).slice(0, 80),
          address: String(body.address),
          tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 16) : [],
          roles: Array.isArray(body.roles) ? body.roles.map(String).slice(0, 16) : [],
          transport: {
            kind: transport.kind || 'direct',
            jumpHostId: transport.jumpHostId || null,
            tailcatAddrRef: null,
            cloudflareHostname: transport.cloudflareHostname || null,
          },
        };
        return { ok: true, ...(await api.add(input)) };
      }
      case 'import': return { ok: true, ...(await api.importFromSshConfig(String(body.config ?? ''))) };
      case 'test': {
        // Before a pin exists, "test" scans the key so the owner can compare it
        // with the fingerprint the bootstrap command printed.
        const current = api.status(body.hostId);
        if (!current?.hostKey) {
          const scanned = await api.scanHostKey(body.hostId);
          return { ok: true, pinned: false, fingerprint: scanned.fingerprint };
        }
        return { ok: true, pinned: true, ...(await api.test(body.hostId)) };
      }
      case 'confirm-pin': return { ok: true, ...(await api.confirmPin(body.hostId, body.fingerprint)) };
      case 'revoke': return { ok: true, ...(await api.revoke(body.hostId)) };
      case 'remove': return { ok: true, ...(await api.remove(body.hostId, { cleanup: body.remoteCleanup === true })) };
      case 'audit': return { ok: true, ...(await hostAudit().read(body.hostId)) };
      case 'permissions': {
        const record = hostsConfig.hosts.find(item => item.id === body.hostId);
        if (!record) throw Object.assign(Error('Unknown SSH host.'), { status: 404 });
        const next = {};
        for (const [agent, level] of Object.entries(body.permissions ?? {})) {
          if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(agent) || !HOST_LEVELS.has(level)) throw Object.assign(Error('Invalid host permission.'), { status: 400 });
          next[agent] = level;
        }
        record.permissions = next;
        saveHosts(hostsConfig);
        return { ok: true, host: api.list().find(item => item.id === record.id) };
      }
      default: throw Object.assign(Error('Unknown host action.'), { status: 400 });
    }
  }

  function configuredAgentCount() {
    try { if (hasAgents()) return 1; } catch { /* fall through to the registry */ }
    try {
      return agentProviderRegistry().list().filter(item => item.configured).length
        + Object.values(discovered || {}).filter(Boolean).length;
    } catch { return 0; }
  }

  /** First run: nothing applied yet and no agent configured or discovered. */
  function firstRun() {
    let applied = false;
    try { applied = Boolean(store.load().appliedAt); } catch { applied = false; }
    return !applied && configuredAgentCount() === 0;
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;
    try {
      if (pathname === '/api/onboarding/state' && req.method === 'GET') {
        const state = onboarding.state();
        return json(res, 200, { ...state, firstRun: firstRun(), roles: resolveRoles(state.config), mode: state.config.mode ?? 'custom', setupAgent: fs.existsSync(setupFile) });
      }
      if (pathname === '/api/onboarding/setup-agent' && req.method === 'GET') {
        let request = null;
        try { request = JSON.parse(fs.readFileSync(setupFile, 'utf8')); } catch { request = null; }
        return json(res, 200, { ok: true, request });
      }
      const scoped = /^\/api\/(?:onboarding|settings)(\/.*)?$/.exec(pathname);
      if (scoped && /^\/(?:repos|github)(?:\/|$)/.test(scoped[1] ?? '') && await githubAndRepos(req, res, scoped[1])) return;
      if (pathname === '/api/onboarding' || pathname.startsWith('/api/onboarding/')) return await onboarding.handle(req, res, url);
      if (pathname === '/api/settings' || pathname.startsWith('/api/settings/')) {
        const inner = new URL(pathname.replace(/^\/api\/settings/, '/api/onboarding') || '/', 'http://localhost');
        if (inner.pathname === '/api/onboarding' && req.method === 'GET') return json(res, 200, { ...onboarding.state(), firstRun: firstRun() });
        return await settings.handle(req, res, inner);
      }
      if (pathname === '/api/hosts') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });
        return json(res, 200, await hostAction(await readJson(req)));
      }
      return json(res, 404, { ok: false, error: 'Not found.' });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      const message = typeof error?.message === 'string' && status < 500 ? error.message.slice(0, 300) : 'Request failed.';
      return json(res, status, { ok: false, error: message });
    }
  }

  /**
   * Start loopback OpenAI-compatible gateways for the chat role when it maps to
   * an OpenAI-compatible endpoint (direct, OpenRouter, Anthropic's compatible
   * API or an enabled router). Returns Orbit agent profiles for index.mjs.
   */
  async function agentProfiles() {
    let config;
    try { config = store.load(); } catch { return []; }
    const chat = resolveRoles(config).chat;
    if (!chat?.provider || !chat.model) return [];
    const provider = config.providers.find(item => item.id === chat.provider);
    if (!provider || !OPENAI_KINDS.has(provider.kind)) return [];
    if (provider.kind === 'router' && !config.router.enabled) return [];
    const agent = store.toRegistryConfig().agents.find(item => item.id === 'chat');
    if (!agent?.baseUrl) return [];
    const label = `${provider.label} · ${chat.model}`.slice(0, 120);
    try {
      const gateway = await startGateway({
        id: 'orbit-chat',
        label,
        baseUrl: agent.baseUrl,
        model: chat.model,
        ...(agent.apiKeyFile ? { apiKeyFile: agent.apiKeyFile } : {}),
        ...(agent.apiKeyEnv ? { apiKeyEnv: agent.apiKeyEnv } : {}),
        runtimeDir: path.join(runtime, 'openai-compat'),
        token: randomBytes(32).toString('base64url'),
        env,
      });
      registerGatewayProvider(OPENAI_COMPAT_PROVIDER);
      agentProviderRegistry().register({
        id: OPENAI_COMPAT_PROVIDER,
        label: 'OpenAI-compatible',
        mark: 'O',
        kind: 'openai-compatible',
        capabilities: { compact: false, modelSwitch: false, contextMeter: false, approvals: false, streaming: true },
        configured: true,
        configHint: 'Configured from orbit-config.json.',
      });
      safeLog('OpenAI-compatible chat agent started on loopback.');
      return [{ id: OPENAI_COMPAT_PROVIDER, label, provider: OPENAI_COMPAT_PROVIDER, apiUrl: gateway.url, apiKey: gateway.token, source: 'orbit-config' }];
    } catch {
      safeLog('The OpenAI-compatible chat agent did not start; check its provider in Settings.');
      return [];
    }
  }

  return { store, handle, firstRun, agentProfiles, startSetupAgent, routerSupervisor, github };
}
