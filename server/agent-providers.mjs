/**
 * Agent provider identity.
 *
 * Hermes is one optional adapter, not the default for every unknown id. Grok Bot
 * and Pi are loopback agent gateways that answer the same command set
 * (`listAgents`, `createAgent`, `sendPrompt`, `getAgentTranscriptTail`,
 * `promptAcceptanceStatus`, `interruptAgentRun`, `GET /events`). Keeping that
 * list in one place means a new gateway provider does not need a second copy of
 * the chat surface, and a provider check cannot silently drift between files.
 *
 * Labels and marks come from the adapter registry. An id that is not registered
 * reads as "Unconfigured adapter" and state "unconfigured"; it never becomes
 * Hermes by accident.
 */
import {
  AGENT_PROVIDER_ID,
  builtinAgentDefinitions,
  createAgentRegistry,
} from './agent-registry.mjs';

export const GATEWAY_PROVIDERS = Object.freeze(['grok', 'pi']);

const UNCONFIGURED_LABEL = 'Unconfigured adapter';
const UNCONFIGURED_MARK = '?';

let activeRegistry = null;

/** The registry backing the label/mark helpers. */
export function agentProviderRegistry() {
  if (!activeRegistry) {
    try {
      activeRegistry = createAgentRegistry({ builtins: builtinAgentDefinitions() });
    } catch {
      // A malformed optional agents file must not stop provider identity from
      // resolving. Explicit configuration still validates and reports errors.
      activeRegistry = createAgentRegistry({ builtins: builtinAgentDefinitions(), config: [] });
    }
  }
  return activeRegistry;
}

/**
 * Replace the registry used by providerLabel/providerMark/providerState.
 * `discovered` marks built-ins that discovery actually found; callers may also
 * pass an explicit `builtins` list or an already-created registry.
 */
export function configureAgentProviders(options = {}) {
  if (options && typeof options.list === 'function' && typeof options.get === 'function') {
    activeRegistry = options;
    return activeRegistry;
  }
  const { discovered, builtins, ...rest } = options || {};
  activeRegistry = createAgentRegistry({
    ...rest,
    builtins: builtins ?? builtinAgentDefinitions({ discovered }),
  });
  return activeRegistry;
}

export function agentProviderSummary() {
  return agentProviderRegistry().summary();
}

function providerId(provider) {
  // A missing provider id is the legacy Hermes profile. An explicit unknown id
  // is not: it stays unknown and reads as unconfigured.
  if (provider === undefined || provider === null) return 'hermes';
  if (typeof provider !== 'string') return 'unknown';
  const id = provider.trim();
  if (id === 'default') return 'hermes';
  return AGENT_PROVIDER_ID.test(id) ? id : 'unknown';
}

// Gateway providers added at runtime (for example the OpenAI-compatible chat
// agent configured in orbit-config.json). The static list stays the built-ins.
const runtimeGatewayProviders = new Set();

/** Mark a configured adapter id as reached through the gateway command set. */
export function registerGatewayProvider(id) {
  if (typeof id !== 'string' || !AGENT_PROVIDER_ID.test(id) || id === 'hermes') throw Error('Invalid gateway provider id.');
  runtimeGatewayProviders.add(id);
}

/** True for a provider Orbit reaches through an agent gateway rather than Hermes. */
export function isGatewayProvider(provider) {
  const id = providerId(provider);
  return GATEWAY_PROVIDERS.includes(id) || runtimeGatewayProviders.has(id);
}

/** Display name for a provider id. Unknown ids are unconfigured, never Hermes. */
export function providerLabel(provider) {
  return agentProviderRegistry().get(providerId(provider))?.label || UNCONFIGURED_LABEL;
}

/** One- or two-character badge used in session lists and model menus. */
export function providerMark(provider) {
  return agentProviderRegistry().get(providerId(provider))?.mark || UNCONFIGURED_MARK;
}

/** 'configured' only when the adapter registry marks this provider usable. */
export function providerState(provider) {
  return agentProviderRegistry().get(providerId(provider))?.configured ? 'configured' : 'unconfigured';
}

/** Display name for a profile: the discovered label when present, else the provider name. */
export function profileName(profile) {
  const label = typeof profile?.label === 'string' ? profile.label.trim() : '';
  return label || providerLabel(profile?.provider);
}

/** Provider ids present in a profile catalog, in catalog order. */
export function providerIds(catalog) {
  const list = Array.isArray(catalog?.list) ? catalog.list : [];
  const ids = [];
  for (const profile of list) {
    const provider = typeof profile?.provider === 'string' ? profile.provider : 'hermes';
    if (!ids.includes(provider)) ids.push(provider);
  }
  return ids;
}
