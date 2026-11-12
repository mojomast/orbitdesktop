// Step 4 review: components, providers (masked keys only), role mapping and
// what will actually run. Importing this module never touches the document.

import type { ProviderLike, RoleChoice, RoleConfigLike } from './onboarding-roles.ts';
import { effectiveRoles, roleRows } from './onboarding-roles.ts';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

export type SetupMode = 'minimal' | 'custom';

export interface ReviewConfigLike extends RoleConfigLike {
  mode?: SetupMode;
  components?: Record<string, boolean | string[]>;
  router?: {
    enabled?: boolean;
    mode?: 'builtin' | 'external';
    engine?: string;
    bind?: 'internal' | 'loopback';
    port?: number;
  };
  appliedAt?: string;
}

export interface ReviewSummary {
  mode: SetupMode;
  components: string[];
  providerPath: string;
  runs: string;
  providers: Array<{ id: string; label: string; kind: string; key: string; active: boolean }>;
  roles: Array<{ role: string; label: string; provider: string; model: string; inherits: boolean }>;
}

/** What applying will start locally. Only the built-in router starts anything. */
export function reviewRunsText(config: ReviewConfigLike | null | undefined): string {
  if (config?.router?.enabled && config.router.mode !== 'external') return '1 container: router, no host port, ~300 MB RAM';
  return 'nothing extra';
}

export function reviewProviderPath(config: ReviewConfigLike | null | undefined): string {
  if (!config?.router?.enabled) return 'Direct providers';
  return config.router.mode === 'external' ? 'External router' : 'Built-in token router';
}

export function reviewSummary(config: ReviewConfigLike, providers: ProviderLike[], roles?: Record<string, RoleChoice>): ReviewSummary {
  const components = Object.entries(config.components ?? {})
    .filter(([key, value]) => key !== 'apps' && value === true)
    .map(([key]) => key);
  const effective = roles ?? effectiveRoles(config);
  const rows = roleRows(config, roles);
  return {
    mode: config.mode === 'minimal' ? 'minimal' : 'custom',
    components,
    providerPath: reviewProviderPath(config),
    runs: reviewRunsText(config),
    providers: providers.map(provider => ({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      key: provider.key?.set ? (provider.key.masked ?? 'set') : 'not set',
      active: provider.kind === 'router' ? Boolean(config.router?.enabled) : true,
    })),
    roles: rows.map(row => ({
      role: row.role,
      label: row.label,
      provider: row.provider || effective[row.role]?.provider || '',
      model: row.model || effective[row.role]?.model || '',
      inherits: row.inherits,
    })),
  };
}

export interface ReviewStepApiLike {
  apply(payload?: unknown): Promise<unknown>;
}

export interface ReviewStepContextLike {
  api: ReviewStepApiLike;
  config: ReviewConfigLike;
  providers: ProviderLike[];
  notify(message: string, error?: boolean): void;
  refresh?(): Promise<void>;
}

/**
 * Editable summary of step 4. The wizard footer also applies; this button is
 * available to Settings and for keyboard users who review the panel directly.
 */
export function renderReviewStep(context: ReviewStepContextLike): HTMLElement {
  const section = node('section', 'onboarding-step-panel onboarding-review-step');
  const summary = reviewSummary(context.config, context.providers);
  section.append(
    node('h2', '', 'Review and apply'),
    node('p', '', 'Applying saves orbit-config.json and starts the setup agent with only the components you chose. Keys stay masked here and live in 0600 files.'),
  );

  const list = node('dl', 'onboarding-review-list');
  list.append(
    node('dt', '', 'Mode'), node('dd', '', summary.mode === 'minimal' ? 'Minimal install' : 'Custom'),
    node('dt', '', 'Components'), node('dd', '', summary.components.join(', ') || 'core'),
    node('dt', '', 'Provider path'), node('dd', '', summary.providerPath),
    node('dt', '', 'Providers'), node('dd', '', summary.providers.length
      ? summary.providers.map(provider => `${provider.label} (${provider.kind}; key ${provider.key}${provider.active ? '' : ', stored only'})`).join(', ')
      : 'None yet'),
    node('dt', '', 'Runs locally'), node('dd', '', summary.runs),
    node('dt', '', 'Applied'), node('dd', '', context.config.appliedAt ?? 'Not yet'),
  );
  section.append(list);

  const roles = node('dl', 'onboarding-review-list onboarding-review-roles');
  for (const role of summary.roles) {
    roles.append(
      node('dt', '', role.label),
      node('dd', '', role.provider ? `${role.provider} · ${role.model}${role.inherits ? ' (inherits default model)' : ''}` : 'Not chosen yet'),
    );
  }
  section.append(node('h3', '', 'Models by role'), roles);
  section.append(node('p', 'onboarding-note', summary.runs === 'nothing extra'
    ? 'Nothing extra runs in the background: no router container or host port.'
    : 'The token router stays internal with no host port; only its container starts.'));

  const apply = node('button', 'onboarding-primary onboarding-apply', 'Apply choices') as HTMLButtonElement;
  apply.type = 'button';
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    context.notify('Applying setup choices…');
    try {
      await context.api.apply();
      context.notify('Choices applied. The setup agent will install the selected components.');
      await context.refresh?.();
    } catch (error) {
      context.notify(error instanceof Error ? error.message : 'The setup choices could not be applied.', true);
    } finally {
      apply.disabled = false;
    }
  });
  section.append(apply);
  return section;
}
