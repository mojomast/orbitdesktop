/**
 * Client mirror of `server/agent-providers.mjs`.
 *
 * The browser only ever sees the provider id and label the server sent, so this
 * file is the single place the pane decides how a provider is named, badged,
 * and whether it is a loopback agent gateway instead of Hermes.
 */
export type AgentProvider = 'hermes' | 'grok' | 'pi';

export const GATEWAY_PROVIDERS: AgentProvider[] = ['grok', 'pi'];

const labels: Record<string, string> = { hermes: 'Hermes', grok: 'Grok Bot', pi: 'Pi' };
const marks: Record<string, string> = { hermes: 'H', grok: 'G', pi: 'P' };

export function asProvider(value: unknown): AgentProvider {
  return value === 'grok' || value === 'pi' ? value : 'hermes';
}

/** True when this provider is reached through an agent gateway, not the Hermes run API. */
export function isGatewayProvider(provider: unknown): boolean {
  return GATEWAY_PROVIDERS.includes(asProvider(provider));
}

/** Display name for a provider id. */
export function providerLabel(provider: unknown): string {
  return labels[asProvider(provider)];
}

/** One-letter badge used in session lists and model menus. */
export function providerMark(provider: unknown): string {
  return marks[asProvider(provider)];
}
