/**
 * The built-in setup agent.
 *
 * The first agent a person connects is asked to help them deploy the rest of
 * the workflow. This module turns the agent-neutral skill and the wizard config
 * view into one bounded prompt and one structured checklist. It never reads a
 * key value: providers are rendered from a masked status only.
 */
import fs from 'node:fs';

const SKILL_URL = new URL('../skills/setup-agent/SKILL.md', import.meta.url);
const HEALTH_PATH = '/api/health';
const LOCAL_WORKERS_PATH = '/api/local-workers';
const DEFAULT_PORT = 4318;
const DEFAULT_ROUTER_PORT = 8080;
const DEFAULT_LITELLM_PORT = 4000;

const AGENT_ORDER = ['pi', 'opencode', 'hermes'];
const AGENT_LABELS = Object.freeze({ pi: 'Pi', opencode: 'OpenCode', hermes: 'Hermes' });
const AGENT_VERIFY = Object.freeze({
  pi: 'pi --version',
  opencode: 'opencode --version',
  hermes: 'hermes --version',
});
const AGENT_ALIASES = Object.freeze({
  pi: ['pi', 'agentPi', 'agent-pi', 'piAgent', 'pi_agent'],
  opencode: ['opencode', 'agentOpenCode', 'agent-opencode', 'openCode'],
  hermes: ['hermes', 'agentHermes', 'agent-hermes'],
});
const WORKER_ALIASES = ['workers', 'workerPairing', 'worker_pairing', 'worker-pairing', 'localWorkers', 'local_workers', 'worker'];
const APP_ALIASES = ['apps', 'optionalApps', 'optional_apps', 'optional-apps', 'optionalAppsComponent'];
const ROUTER_ALIASES = ['router'];
const LITELLM_ALIASES = ['litellmLocal', 'litellm_local', 'litellm-local', 'localLitellm', 'local_litellm'];
const KNOWN_INSTALL_STATES = new Set(['pending', 'running', 'installed', 'failed', 'skipped', 'done', 'ready', 'unknown']);
const ROLE_ORDER = ['setup', 'chat', 'workers', 'summarize', 'router', 'colab', 'apps'];
const SECRET_LIKE = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[a-z])[-_][A-Za-z0-9_-]{8,}\b/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,95}$/;

let cachedSkill;
function skillText() {
  if (cachedSkill === undefined) cachedSkill = fs.readFileSync(SKILL_URL, 'utf8');
  return cachedSkill;
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function truthy(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'installed', 'enabled', 'running', 'ready'].includes(text)) return true;
    if (['0', 'false', 'no', 'off', 'missing', 'disabled', 'unset', 'not-set', 'not_set'].includes(text)) return false;
  }
  if (isObject(value)) {
    if (hasOwn(value, 'enabled')) return truthy(value.enabled, fallback);
    if (hasOwn(value, 'selected')) return truthy(value.selected, fallback);
    if (hasOwn(value, 'installed')) return truthy(value.installed, fallback);
  }
  return fallback;
}

function safeDisplay(value, max = 72) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || SECRET_LIKE.test(text)) return '';
  return text.slice(0, max);
}

function safeToken(value, max = 96) {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || SECRET_LIKE.test(text) || !TOKEN.test(text)) return '';
  return text.slice(0, max);
}

function safePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function orbitPort(config) {
  return safePort(config?.orbit?.port ?? config?.server?.port ?? config?.port, DEFAULT_PORT);
}

function safeBaseUrl(value, fallback = '') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return fallback;
    if (url.username || url.password || url.search || url.hash) return fallback;
    return url.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function pickComponent(components, aliases, fallback) {
  if (!isObject(components)) return fallback;
  for (const alias of aliases) {
    if (hasOwn(components, alias)) return truthy(components[alias], fallback);
  }
  return fallback;
}

function selectedComponents(config) {
  const components = isObject(config?.components) ? config.components : null;
  const allByDefault = !components;
  const bundlebees = pickComponent(components, ['bundlebees', 'execution'], allByDefault);
  const workers = pickComponent(components, WORKER_ALIASES, allByDefault ? true : bundlebees);
  return {
    core: true,
    pi: pickComponent(components, AGENT_ALIASES.pi, allByDefault),
    opencode: pickComponent(components, AGENT_ALIASES.opencode, allByDefault),
    hermes: pickComponent(components, AGENT_ALIASES.hermes, allByDefault),
    bundlebees,
    workers,
    colab: pickComponent(components, ['colab'], false),
    apps: pickComponent(components, APP_ALIASES, false),
    router: pickComponent(components, ROUTER_ALIASES, false),
    litellmLocal: pickComponent(components, LITELLM_ALIASES, false),
  };
}

function providerStatus(provider) {
  if (typeof provider.hasKey === 'boolean') return provider.hasKey ? 'key set' : 'key missing';
  const text = typeof provider.keyStatus === 'string' ? provider.keyStatus.trim().toLowerCase() : '';
  if (['set', 'configured', 'present', 'ready', 'installed', 'enabled'].includes(text)) return 'key set';
  if (['missing', 'unset', 'not-set', 'not_set', 'none', 'absent', 'required'].includes(text)) return 'key missing';
  if (provider.apiKey !== undefined || provider.key !== undefined) return 'key set';
  return 'key status unknown';
}

function providerSummaries(config) {
  const raw = config?.providers;
  const providers = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? Object.entries(raw).map(([id, value]) => (isObject(value) ? { id, ...value } : { id, keyStatus: value }))
      : [];
  const list = [];
  providers.forEach((provider, index) => {
    if (!isObject(provider)) return;
    const id = safeToken(provider.id ?? provider.providerId ?? provider.label) || `provider-${index + 1}`;
    const label = safeDisplay(provider.label ?? provider.name) || id;
    list.push({ id, label, status: providerStatus(provider) });
  });
  return list;
}

function roleEntry(value) {
  if (typeof value === 'string') {
    const [provider, model] = value.split(/\s*\/\s*/, 2);
    return { provider: safeToken(provider) || 'provider', model: safeToken(model) || 'default' };
  }
  if (!isObject(value)) return null;
  const rawProvider = value.provider ?? value.providerId ?? value.id;
  const rawModel = value.model ?? value.modelId ?? value.default;
  const provider = safeToken(isObject(rawProvider) ? rawProvider.id ?? rawProvider.label : rawProvider) || 'provider';
  const model = safeToken(isObject(rawModel) ? rawModel.id ?? rawModel.model ?? rawModel.label : rawModel) || 'default';
  return { provider, model };
}

function roleMap(config) {
  const roles = isObject(config?.roles) ? config.roles : {};
  const entries = [];
  const seen = new Set();
  const keys = Object.keys(roles).sort((a, b) => {
    const ai = ROLE_ORDER.indexOf(a);
    const bi = ROLE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  for (const key of keys) {
    const safeKey = safeToken(key, 48);
    const entry = roleEntry(roles[key]);
    if (!safeKey || !entry || seen.has(safeKey)) continue;
    seen.add(safeKey);
    entries.push([safeKey, entry]);
  }
  return new Map(entries);
}

function installStateText(value) {
  if (!isObject(value)) return 'not reported';
  const parts = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = safeToken(rawKey, 48);
    if (!key) continue;
    let state = 'recorded';
    if (typeof rawValue === 'string' && KNOWN_INSTALL_STATES.has(rawValue.trim().toLowerCase())) state = rawValue.trim().toLowerCase();
    else if (rawValue === true) state = 'installed';
    else if (rawValue === false) state = 'pending';
    parts.push(`${key}=${state}`);
    if (parts.length >= 12) break;
  }
  return parts.length ? parts.join(', ') : 'not reported';
}

function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
  } catch {
    return false;
  }
}

function routerView(config) {
  const router = isObject(config?.router) ? config.router : {};
  const external = isObject(router.external) ? router.external : {};
  const rawBase = external.baseUrl ?? router.baseUrl ?? config?.routerBaseUrl;
  const modeText = typeof router.mode === 'string' ? router.mode.trim().toLowerCase() : '';
  const inferred = typeof rawBase === 'string' && rawBase.trim() && !isLoopbackUrl(rawBase) ? 'external' : 'builtin';
  const mode = ['builtin', 'external'].includes(modeText) ? modeText : inferred;
  const engineText = typeof router.engine === 'string' ? router.engine.trim().toLowerCase() : '';
  const engine = ['bifrost', 'litellm'].includes(engineText) ? engineText : 'bifrost';
  const port = safePort(router.port, engine === 'litellm' ? DEFAULT_LITELLM_PORT : DEFAULT_ROUTER_PORT);
  const fallbackBase = `http://127.0.0.1:${port}/v1`;
  const baseUrl = mode === 'external' ? safeBaseUrl(rawBase, '') : safeBaseUrl(rawBase, fallbackBase);
  return { mode, engine, port, baseUrl: baseUrl || '', configured: Boolean(baseUrl) };
}

function chosenNames(selected) {
  const names = [];
  for (const key of AGENT_ORDER) if (selected[key]) names.push(AGENT_LABELS[key]);
  if (selected.bundlebees) names.push('bundlebees');
  if (selected.workers) names.push('workers');
  if (selected.colab) names.push('colab');
  if (selected.apps) names.push('apps');
  if (selected.router) names.push('router');
  if (selected.litellmLocal) names.push('local LiteLLM');
  return names;
}

function roleLine(roles, keys) {
  const parts = [];
  for (const key of keys) {
    const entry = roles.get(key);
    if (entry) parts.push(`${key}: ${entry.provider} / ${entry.model}`);
  }
  return parts.join('; ');
}

function routerActive(config, selected) {
  const mode = typeof config?.providerMode === 'string' ? config.providerMode.trim().toLowerCase() : '';
  return selected.router || selected.litellmLocal || mode === 'router' || config?.router?.enabled === true;
}

function routingNotes(config, selected, router, roles) {
  const lines = [];
  if (!routerActive(config, selected)) {
    lines.push('Provider mode: direct. Each selected part uses the provider and model named in the role mapping; no local router runs.');
    return lines;
  }
  if (selected.litellmLocal) {
    lines.push(`Provider mode: router. The explicitly selected local LiteLLM proxy is the router endpoint at ${router.engine === 'litellm' ? `http://127.0.0.1:${DEFAULT_LITELLM_PORT}/v1` : router.baseUrl || 'the runtime-configured endpoint'}.`);
  } else if (router.mode === 'external') {
    lines.push(`Router mode: external. Point every router-backed agent at ${router.configured ? router.baseUrl : 'the external base URL configured in Orbit settings'}; Orbit does not start or supervise an external router.`);
  } else {
    lines.push(`Router mode: built-in (${router.engine === 'litellm' ? 'LiteLLM advanced' : 'Bifrost by default'}). Orbit's onboarding wizard and Settings call the router supervisor; the setup agent never starts the router itself and never asks for keys in chat.`);
    lines.push(`Router base URL for host-run agents: ${router.configured ? router.baseUrl : 'configure it in Orbit settings first'}.`);
  }
  if (roles.size) {
    const routed = [...roles.entries()].filter(([, entry]) => entry.provider === 'router');
    if (routed.length) lines.push(`Role models through the router: ${routed.map(([key, entry]) => `${key}=${entry.model}`).join(', ')}.`);
  }
  lines.push('Each role gets its own virtual key (for example setup, chat, workers and summarize). Orbit stores it as a 0600 key file under the runtime key directory and injects the matching key into that role; masked status only is shown to the agent.');
  lines.push('OpenCode free models stay direct to OpenCode. They cannot be fronted by the router; only paid or self-hosted OpenCode endpoints can use the router base URL.');
  return lines;
}

function litellmDetail(config) {
  const providers = providerSummaries(config).map((provider) => provider.id).filter((id) => id !== 'router');
  const names = providers.length ? providers.join(', ') : 'the upstream providers chosen in the wizard';
  const envRefs = (providers.length ? providers : ['provider']).map((id) => envName(id)).join(', ');
  return [
    'This is an explicit advanced opt-in. Run it only after the person confirms this step.',
    `Render runtime/router/litellm.yaml from the selected upstream providers (${names}) with key references only: ${envRefs}. Load those values from 0600 key files under the runtime key directory; never inline an upstream key.`,
    'Generate a master key into a 0600 file under runtime/router and load it from the environment; never put the value on a command line.',
    'Compose path: docker compose --profile router up -d router',
    "npm path: pipx install 'litellm[proxy]' then litellm --config <runtime>/router/litellm.yaml --host 127.0.0.1 --port 4000",
    'Then set providerMode to router and the router base URL to http://127.0.0.1:4000/v1 in the wizard, and record the step with PUT /api/onboarding/install-state.',
  ].join('\n   ');
}

function envName(id) {
  const name = String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `os.environ/${name || 'PROVIDER'}_API_KEY`;
}

function buildSteps(config) {
  const selected = selectedComponents(config);
  const roles = roleMap(config);
  const providers = providerSummaries(config);
  const router = routerView(config);
  const port = orbitPort(config);
  const health = `curl -fsS http://127.0.0.1:${port}${HEALTH_PATH}`;
  const localWorkers = `curl -fsS http://127.0.0.1:${port}${LOCAL_WORKERS_PATH}`;
  const steps = [];
  const add = (id, title, verify, detail) => steps.push({ id, title, verify, detail });

  add(
    'core',
    'Verify the core Orbit service is healthy',
    health,
    'Orbit core is already running. Confirm the health response before changing anything; do not reconfigure or restart a live workspace.',
  );
  add(
    'workflow',
    'Clone and read mojomast/workflow, then run the offline reference demo',
    'python3 reference/run_demo.py',
    'The workflow repository is the shared protocol: briefs, leases, evidence and approvals. Show the clone command and the demo command before running either, then run the offline reference demo from the repository root.',
  );

  for (const key of AGENT_ORDER) {
    if (!selected[key]) continue;
    const label = AGENT_LABELS[key];
    add(
      key,
      `Install and connect the ${label} agent adapter`,
      AGENT_VERIFY[key],
      `Connect ${label} through the adapter contract in docs/ADAPTERS.md. Show the install command first and ask before installing. ${rosterHint(label, roles, routerActive(config, selected), router)}`,
    );
  }

  if (selected.litellmLocal) {
    add(
      'litellmLocal',
      'Install and start the explicitly selected local LiteLLM proxy',
      'curl -fsS http://127.0.0.1:4000/health',
      litellmDetail(config),
    );
  }

  if (routerActive(config, selected) && !selected.litellmLocal) {
    add(
      'router',
      'Confirm the built-in router state through Orbit settings',
      router.mode === 'external'
        ? (router.configured ? `curl -fsS ${router.baseUrl}/models` : health)
        : `curl -fsS ${router.baseUrl || `http://127.0.0.1:${DEFAULT_ROUTER_PORT}/v1`}/models`,
      router.mode === 'external'
        ? `External router: point adapters at ${router.configured ? router.baseUrl : 'the external base URL configured in Orbit settings'}. Orbit does not start or supervise an external router.`
        : `Built-in router: ${router.engine === 'litellm' ? 'LiteLLM advanced' : 'Bifrost by default'}. Orbit's wizard and Settings call the router supervisor; this setup agent never starts it on its own.`,
    );
  }

  if (selected.bundlebees) {
    add(
      'bundlebees',
      'Install bundlebees and point it at the Orbit local-workers API',
      localWorkers,
      `bundlebees is the execution layer. Point it at the loopback local-workers API http://127.0.0.1:${port}${LOCAL_WORKERS_PATH} and keep its token in a private file or environment variable, never in chat. ${rosterHint('bundlebees workers', roles, routerActive(config, selected), router)}`,
    );
  }

  if (selected.workers) {
    add(
      'workers',
      'Set up local workers first, then add a remote launcher only if chosen',
      localWorkers,
      `Start with a local worker on this machine. A remote launcher is optional and must stay reachable only on the path the person explicitly chose. ${rosterHint('workers', roles, routerActive(config, selected), router)}`,
    );
  }

  if (selected.colab) {
    add(
      'colab',
      'Enable the Colab orchestrator',
      health,
      'Colab decomposes a goal into tracked tasks. Enable it only if the person chose it and confirm the plan/approval boundaries in docs/COLLAB.md.',
    );
  }

  if (selected.apps) {
    add(
      'apps',
      'Install the optional apps chosen in the wizard',
      health,
      'Install only the optional apps the person selected. Each app keeps its own data and credentials; do not widen Orbit beyond loopback unless the person explicitly asks.',
    );
  }

  return { steps, selected, roles, providers, router };
}

function rosterHint(label, roles, activeRouter, router) {
  const keys = label === 'workers' || label.includes('workers') ? ['workers'] : ['chat', label.toLowerCase()];
  const line = roleLine(roles, keys) || roleLine(roles, ['chat']);
  const parts = [];
  if (line) parts.push(`Uses ${line}.`);
  if (activeRouter) parts.push(`Route through ${router.mode === 'external' ? 'the external router base URL' : 'the router supervisor base URL'} and use that role's virtual key; never paste a key in chat.`);
  return parts.join(' ');
}

function stateHeader({ agentLabel, config }) {
  const label = safeDisplay(agentLabel, 80) || 'the connected agent';
  if (!isObject(config)) {
    return `Orbit setup agent for ${label}. No wizard config was supplied; use the neutral checklist and ask the person what they want to install.`;
  }
  const selected = selectedComponents(config);
  const chosen = chosenNames(selected);
  const mode = typeof config.providerMode === 'string' && config.providerMode.trim() ? safeDisplay(config.providerMode, 24) : 'direct';
  const schema = safeToken(config.schemaVersion, 16) || 'unknown';
  return `Orbit setup agent for ${label}. Config schema ${schema}; provider mode ${mode}; chosen: ${chosen.length ? chosen.join(', ') : 'core only'}; install state: ${installStateText(config.installState)}.`;
}

function renderPlan(config) {
  const { steps, selected, roles, providers, router } = buildSteps(config);
  const activeRouter = routerActive(config, selected);
  const lines = ['Chosen steps, in order. Show each command before running it and ask before installing anything.'];
  if (!steps.length) lines.push('No optional components are selected.');
  steps.forEach((step, index) => {
    lines.push(`${index + 1}. [${step.id}] ${step.title}`);
    lines.push(`   Verify: ${step.verify}`);
    lines.push(`   ${step.detail}`);
  });
  lines.push('');
  if (providers.length) {
    lines.push(`Providers (masked status only): ${providers.map((provider) => `${provider.label} (${provider.status})`).join(', ')}.`);
  } else {
    lines.push('Providers: none listed in the config view; ask the person to add one in the onboarding key form, never in chat.');
  }
  if (roles.size) {
    lines.push(`Role mapping: ${[...roles.entries()].map(([key, entry]) => `${key}: ${entry.provider} / ${entry.model}`).join('; ')}.`);
  } else {
    lines.push('Role mapping: not set; use the wizard defaults or ask the person to choose a provider and model per role.');
  }
  lines.push(...routingNotes(config, selected, router, roles));
  lines.push('');
  lines.push('Progress: after each confirmed step, send PUT /api/onboarding/install-state with JSON {"id":"<step id>","state":"installed"} (or "running", "failed", "skipped"). The endpoint updates installState for the wizard; it is served by the onboarding route.');
  lines.push('Safety: never ask for secrets in chat; point the person to the onboarding key form or environment variables. Keep Orbit on loopback unless the person explicitly says to expose it.');
  return lines.join('\n');
}

/**
 * Return the agent-neutral skill plus a short state header and the plan built
 * from the wizard config view. The config may contain masked provider status,
 * roles and install state, but never a key value; unknown fields are ignored.
 */
export function setupAgentPrompt({ agentLabel, config } = {}) {
  const header = stateHeader({ agentLabel, config });
  if (!isObject(config)) {
    return `${header}\n\n${renderPlan(null)}\n\n---\n\n${skillText()}`;
  }
  return `${header}\n\n${renderPlan(config)}\n\n---\n\n${skillText()}`;
}

/**
 * Return only the chosen components' checklist steps. Each step has an id, a
 * title and a verify command. Verify commands contain no keys or tokens.
 */
export function setupChecklist(config) {
  const steps = buildSteps(isObject(config) ? config : null).steps;
  return steps.map(({ id, title, verify }) => ({ id, title, verify }));
}
