/**
 * Client mirror of `server/agent-providers.mjs`.
 *
 * The browser only ever sees the provider id and label the server sent, so this
 * file is the single place the pane decides how a provider is named, badged,
 * and whether it is a loopback agent gateway instead of Hermes. Unknown ids are
 * unconfigured adapters; they are never relabelled as Hermes.
 */
export type AgentProvider = string;

export type AgentProviderState = 'configured' | 'unconfigured';

export type AgentProviderCapabilities = {
  compact: boolean;
  modelSwitch: boolean;
  contextMeter: boolean;
  approvals: boolean;
  streaming: boolean;
};

export type AgentProviderDefinition = {
  id: string;
  label: string;
  mark: string;
  kind: string;
  capabilities: AgentProviderCapabilities;
  configured: boolean;
  configHint: string;
};

export const GATEWAY_PROVIDERS: AgentProvider[] = ['grok', 'pi'];

export const UNCONFIGURED_LABEL = 'Unconfigured adapter';
export const UNCONFIGURED_MARK = '?';

const AGENT_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CAPABILITY_KEYS: (keyof AgentProviderCapabilities)[] = ['compact', 'modelSwitch', 'contextMeter', 'approvals', 'streaming'];
const EMPTY_CAPABILITIES: AgentProviderCapabilities = {
  compact: false,
  modelSwitch: false,
  contextMeter: false,
  approvals: false,
  streaming: false,
};

const BUILTINS: AgentProviderDefinition[] = [
  { id: 'hermes', label: 'Hermes', mark: 'H', kind: 'hermes', capabilities: { compact: true, modelSwitch: true, contextMeter: true, approvals: true, streaming: true }, configured: false, configHint: 'Configure a Hermes API connection.' },
  { id: 'grok', label: 'Grok Bot', mark: 'G', kind: 'grok', capabilities: { compact: true, modelSwitch: false, contextMeter: true, approvals: true, streaming: true }, configured: false, configHint: 'Configure a Grok Bot gateway.' },
  { id: 'pi', label: 'Pi', mark: 'P', kind: 'pi', capabilities: { compact: true, modelSwitch: true, contextMeter: true, approvals: false, streaming: true }, configured: false, configHint: 'Configure the Pi harness.' },
];

let registry = new Map<string, AgentProviderDefinition>(BUILTINS.map(definition => [definition.id, cloneDefinition(definition)]));

function cloneDefinition(definition: AgentProviderDefinition): AgentProviderDefinition {
  return { ...definition, capabilities: { ...definition.capabilities } };
}

function normalizeDefinition(value: AgentProviderDefinition): AgentProviderDefinition {
  if (!value || typeof value !== 'object') throw new Error('Invalid agent provider definition.');
  if (typeof value.id !== 'string' || !AGENT_PROVIDER_ID.test(value.id)) throw new Error('Invalid agent provider definition.');
  if (typeof value.label !== 'string' || !value.label.trim()) throw new Error('Invalid agent provider definition.');
  if (typeof value.mark !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,2}$/u.test(value.mark)) throw new Error('Invalid agent provider definition.');
  if (typeof value.kind !== 'string' || !value.kind) throw new Error('Invalid agent provider definition.');
  if (typeof value.configured !== 'boolean') throw new Error('Invalid agent provider definition.');
  if (typeof value.configHint !== 'string') throw new Error('Invalid agent provider definition.');
  if (!value.capabilities || typeof value.capabilities !== 'object') throw new Error('Invalid agent provider definition.');
  const capabilities = { ...EMPTY_CAPABILITIES };
  for (const key of CAPABILITY_KEYS) {
    if (value.capabilities[key] === undefined) continue;
    if (typeof value.capabilities[key] !== 'boolean') throw new Error('Invalid agent provider definition.');
    capabilities[key] = value.capabilities[key];
  }
  return { id: value.id, label: value.label, mark: value.mark, kind: value.kind, capabilities, configured: value.configured, configHint: value.configHint };
}

function providerId(value: unknown): string {
  // A missing provider id is the legacy Hermes profile. An explicit unknown id
  // is not: it stays unknown and reads as unconfigured.
  if (value === undefined || value === null) return 'hermes';
  if (typeof value !== 'string') return 'unknown';
  const id = value.trim();
  if (id === 'default') return 'hermes';
  return AGENT_PROVIDER_ID.test(id) ? id : 'unknown';
}

/** Replace the client-side provider catalog (for example from a server response). */
export function setAgentProviders(definitions: AgentProviderDefinition[]): void {
  if (!Array.isArray(definitions)) throw new Error('Invalid agent provider definitions.');
  registry = new Map(definitions.map(definition => {
    const normalized = normalizeDefinition(definition);
    return [normalized.id, normalized];
  }));
}

/** Add or replace one client-side provider definition. */
export function registerAgentProvider(definition: AgentProviderDefinition): AgentProviderDefinition {
  const normalized = normalizeDefinition(definition);
  registry.set(normalized.id, normalized);
  return cloneDefinition(normalized);
}

export function asProvider(value: unknown): AgentProvider {
  return providerId(value);
}

/** True when this provider is reached through an agent gateway, not the Hermes run API. */
export function isGatewayProvider(provider: unknown): boolean {
  return GATEWAY_PROVIDERS.includes(asProvider(provider));
}

/** Display name for a provider id. Unknown ids are unconfigured, never Hermes. */
export function providerLabel(provider: unknown): string {
  return registry.get(providerId(provider))?.label ?? UNCONFIGURED_LABEL;
}

/** One- or two-character badge used in session lists and model menus. */
export function providerMark(provider: unknown): string {
  return registry.get(providerId(provider))?.mark ?? UNCONFIGURED_MARK;
}

/** 'configured' only when the provider catalog marks this adapter usable. */
export function providerState(provider: unknown): AgentProviderState {
  return registry.get(providerId(provider))?.configured ? 'configured' : 'unconfigured';
}

/** Full client-side definition for advanced menus; unknown ids stay explicit. */
export function providerDefinition(provider: unknown): AgentProviderDefinition {
  const id = providerId(provider);
  const definition = registry.get(id);
  return definition
    ? cloneDefinition(definition)
    : { id, label: UNCONFIGURED_LABEL, mark: UNCONFIGURED_MARK, kind: 'unknown', capabilities: { ...EMPTY_CAPABILITIES }, configured: false, configHint: 'No adapter is registered for this id.' };
}
