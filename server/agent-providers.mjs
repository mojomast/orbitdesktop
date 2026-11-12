/**
 * Agent provider identity.
 *
 * Hermes is the primary profile: Orbit talks to the Hermes API server. Grok Bot
 * and Pi are loopback agent gateways that answer the same command set
 * (`listAgents`, `createAgent`, `sendPrompt`, `getAgentTranscriptTail`,
 * `promptAcceptanceStatus`, `interruptAgentRun`, `GET /events`). Keeping that
 * list in one place means a new gateway provider does not need a second copy of
 * the chat surface, and a provider check cannot silently drift between files.
 */
export const GATEWAY_PROVIDERS = Object.freeze(['grok', 'pi']);

const labels = Object.freeze({ hermes: 'Hermes', grok: 'Grok Bot', pi: 'Pi' });
const marks = Object.freeze({ hermes: 'H', grok: 'G', pi: 'P' });

/** True for a provider Orbit reaches through an agent gateway rather than Hermes. */
export function isGatewayProvider(provider) {
  return GATEWAY_PROVIDERS.includes(typeof provider === 'string' ? provider : '');
}

/** Display name for a provider id. Unknown ids read as Hermes, the default profile. */
export function providerLabel(provider) {
  if (typeof provider !== 'string') return labels.hermes;
  return labels[provider] || labels.hermes;
}

/** One-letter badge used in session lists and model menus. */
export function providerMark(provider) {
  if (typeof provider !== 'string') return marks.hermes;
  return marks[provider] || marks.hermes;
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
