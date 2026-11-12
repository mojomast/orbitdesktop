// Role mapping for the Orbit first-run wizard and Settings.
//
// This module deliberately has no runtime imports so the pure role helpers can
// be tested directly. It never sees a key value: callers pass the masked
// provider view from the server. The DOM helpers reuse the onboarding CSS.

export type RoleId = 'setup' | 'chat' | 'workers' | 'summarize' | 'compaction' | 'vision';
export type SetupMode = 'minimal' | 'custom';

export interface RoleDefinition {
  id: RoleId;
  label: string;
  detail: string;
  required: boolean;
  budget?: { usd: number; reset: string };
}

export const MINIMAL_ROLE_IDS = Object.freeze(['setup', 'chat', 'workers', 'summarize'] as RoleId[]);

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  { id: 'setup', label: 'Setup agent', detail: 'Installs the components you chose and explains each step.', required: true, budget: { usd: 2, reset: '1d' } },
  { id: 'chat', label: 'Chat agents', detail: 'Conversations, questions and everyday workspace work.', required: true, budget: { usd: 10, reset: '1mo' } },
  { id: 'workers', label: 'Bee workers', detail: 'Background tasks and paired worker machines.', required: false, budget: { usd: 20, reset: '1mo' } },
  { id: 'summarize', label: 'Summarize', detail: 'Conversation, document and workspace summaries.', required: false, budget: { usd: 2, reset: '1mo' } },
  { id: 'compaction', label: 'Compaction', detail: 'Optional long-context compaction for busy chats.', required: false },
  { id: 'vision', label: 'Vision', detail: 'Optional image understanding for screenshots and files.', required: false },
];

export interface RoleChoice { provider: string; model: string }
export type RoleMap = Record<string, RoleChoice>;

export interface ProviderLike {
  id: string;
  kind: string;
  label: string;
  baseUrl?: string;
  routerType?: 'hosted' | 'self-hosted';
  active?: boolean;
  key?: { set: boolean; masked: string | null };
}

export interface RoleConfigLike {
  mode?: SetupMode;
  defaultModel?: RoleChoice | null;
  providerMode?: 'direct' | 'router';
  providers?: ProviderLike[];
  roles?: RoleMap;
  router?: { enabled?: boolean; mode?: 'builtin' | 'external'; virtualKeys?: Array<{ role?: string; budget?: { usd?: number; reset?: string }; rateLimit?: { requests?: number; tokens?: number; reset?: string } }> };
}

/** Minimal install is the recommended first-run path. */
export function defaultSetupMode(): SetupMode {
  return 'minimal';
}

function coreIds(): RoleId[] {
  return [...MINIMAL_ROLE_IDS];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Core roles always, plus an optional role only when the config carries it. */
export function roleIds(config: RoleConfigLike | null | undefined): RoleId[] {
  const stored = isPlainObject(config?.roles) ? config!.roles! : {};
  return ROLE_DEFINITIONS
    .filter(definition => MINIMAL_ROLE_IDS.includes(definition.id) || Object.hasOwn(stored, definition.id))
    .map(definition => definition.id);
}

export function effectiveRoles(config: RoleConfigLike | null | undefined): Record<string, RoleChoice> {
  const stored = isPlainObject(config?.roles) ? config!.roles! : {};
  const fallback = config?.defaultModel?.provider && config?.defaultModel?.model ? config.defaultModel : null;
  const result: Record<string, RoleChoice> = {};
  for (const role of roleIds(config)) {
    const entry = stored[role];
    if (entry?.provider && entry?.model) result[role] = { provider: entry.provider, model: entry.model };
    else if (fallback) result[role] = { provider: fallback.provider, model: fallback.model };
    else result[role] = { provider: entry?.provider ?? '', model: entry?.model ?? '' };
  }
  return result;
}

/** Include a router provider only while it is actually active. */
export function providerOptions(config: RoleConfigLike | null | undefined): ProviderLike[] {
  const routerActive = Boolean(config?.router?.enabled);
  return (config?.providers ?? [])
    .filter(provider => provider.kind !== 'router' || routerActive)
    .map(provider => ({ ...provider, active: provider.kind === 'router' ? routerActive : true }));
}

export interface RoleValidation {
  ok: boolean;
  errors: string[];
  roles: Record<string, RoleChoice>;
}

/** Validate editable role choices: known providers and non-empty models. */
export function validateRoles(config: RoleConfigLike | null | undefined, roles: RoleMap | null | undefined): RoleValidation {
  const providers = new Map((config?.providers ?? []).map(provider => [provider.id, provider]));
  const routerActive = Boolean(config?.router?.enabled);
  const errors: string[] = [];
  const normalized: Record<string, RoleChoice> = {};
  for (const role of roleIds(config)) {
    const definition = ROLE_DEFINITIONS.find(entry => entry.id === role)!;
    const entry = roles?.[role] ?? { provider: '', model: '' };
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (!provider && !model) {
      if (definition.required) errors.push(`${definition.label} needs a provider and a model.`);
      normalized[role] = { provider: '', model: '' };
      continue;
    }
    if (!provider || !model) {
      errors.push(`${definition.label} needs both a provider and a model.`);
      continue;
    }
    if (model.length > 200) {
      errors.push(`${definition.label} has too long a model id.`);
      continue;
    }
    const known = providers.get(provider);
    if (!known || (known.kind === 'router' && !routerActive)) {
      errors.push(`Unknown provider "${provider}" for ${definition.label}.`);
      continue;
    }
    normalized[role] = { provider, model };
  }
  return { ok: errors.length === 0, errors, roles: normalized };
}

export interface RoleBudgetRow {
  role: RoleId;
  label: string;
  usd: number;
  reset: string;
  requests: number;
  tokens: number;
  rateReset: string;
}

/** Router budgets are shown only when the built-in router is actually used. */
export function budgetRows(config: RoleConfigLike | null | undefined): RoleBudgetRow[] {
  if (!config?.router?.enabled || config.router.mode === 'external') return [];
  const configured = new Map((config.router.virtualKeys ?? []).filter(entry => typeof entry.role === 'string').map(entry => [entry.role, entry]));
  const rows: RoleBudgetRow[] = [];
  for (const definition of ROLE_DEFINITIONS) {
    if (!definition.budget || !MINIMAL_ROLE_IDS.includes(definition.id)) continue;
    const entry = configured.get(definition.id);
    rows.push({
      role: definition.id,
      label: definition.label,
      usd: typeof entry?.budget?.usd === 'number' ? entry.budget.usd : definition.budget.usd,
      reset: typeof entry?.budget?.reset === 'string' ? entry.budget.reset : definition.budget.reset,
      requests: typeof entry?.rateLimit?.requests === 'number' ? entry.rateLimit.requests : 600,
      tokens: typeof entry?.rateLimit?.tokens === 'number' ? entry.rateLimit.tokens : 2_000_000,
      rateReset: typeof entry?.rateLimit?.reset === 'string' ? entry.rateLimit.reset : '1h',
    });
  }
  return rows;
}

export interface RoleRow {
  role: RoleId;
  label: string;
  detail: string;
  required: boolean;
  provider: string;
  model: string;
  inherits: boolean;
  defaultProvider: string;
  defaultModel: string;
}

/** Display rows used by the wizard, review and Settings. */
export function roleRows(config: RoleConfigLike | null | undefined, override?: RoleMap): RoleRow[] {
  const stored = override ?? config?.roles ?? {};
  const effective = effectiveRoles({ ...config, roles: stored });
  const fallback = config?.defaultModel?.provider && config?.defaultModel?.model ? config.defaultModel : null;
  return roleIds(config).map(role => {
    const definition = ROLE_DEFINITIONS.find(entry => entry.id === role)!;
    const own = stored[role];
    const value = effective[role] ?? { provider: '', model: '' };
    return {
      role,
      label: definition.label,
      detail: definition.detail,
      required: definition.required,
      provider: value.provider,
      model: value.model,
      inherits: Boolean(fallback && !(own?.provider && own?.model)),
      defaultProvider: fallback?.provider ?? '',
      defaultModel: fallback?.model ?? '',
    };
  });
}

export function overrideRole(roles: RoleMap | null | undefined, role: RoleId, provider: string, model: string): RoleMap {
  return { ...(roles ?? {}), [role]: { provider, model } };
}

export function clearRoleOverride(roles: RoleMap | null | undefined, role: RoleId): RoleMap {
  return { ...(roles ?? {}), [role]: { provider: '', model: '' } };
}

const FIRST_AGENT: Record<string, 'opencode' | 'pi'> = { 'opencode-free': 'opencode', pi: 'pi' };

/** Suggested minimal components for one chosen provider kind. */
export function minimalComponents(kind: string | null | undefined): {
  core: boolean; pi: boolean; opencode: boolean; hermes: boolean; bundlebees: boolean; workerPairing: boolean; colab: boolean; router: boolean; apps: string[];
} {
  const agent = kind ? FIRST_AGENT[kind] : undefined;
  return {
    core: true,
    pi: agent === 'pi',
    opencode: agent === 'opencode',
    hermes: false,
    bundlebees: false,
    workerPairing: false,
    colab: false,
    router: kind === 'router',
    apps: [],
  };
}

// ---------------------------------------------------------------------------
// DOM rendering. The functions run only in the browser; importing this module
// in a test does not touch the document.

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function selectField(entries: Array<[string, string]>, value: string, label: string, change: (value: string) => void): HTMLSelectElement {
  const select = node('select', 'onboarding-select');
  select.setAttribute('aria-label', label);
  for (const [optionValue, optionLabel] of entries) {
    const option = node('option', '', optionLabel);
    option.value = optionValue;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => change(select.value));
  return select;
}

export interface ModelListLike {
  models: Array<{ id: string; label?: string; privacyNote?: string }>;
  manual?: boolean;
  default?: string;
}

export interface RolesStepApiLike {
  listModels(providerId: string): Promise<ModelListLike>;
  saveRoles?(payload: unknown): Promise<unknown>;
}

export interface RolesStepContextLike {
  api: RolesStepApiLike;
  config: RoleConfigLike;
  providers: ProviderLike[];
  notify(message: string, error?: boolean): void;
  refresh?(): Promise<void>;
}

export interface RoleDraftEntry extends RoleChoice {
  budget?: { usd: number; reset: string };
  rateLimit?: { requests: number; tokens: number; reset: string };
}

const drafts = new WeakMap<HTMLElement, Record<string, RoleDraftEntry>>();

export function readRoleDraft(element: HTMLElement): Record<string, RoleDraftEntry> {
  return drafts.get(element) ?? {};
}

function modelEntries(models: ModelListLike): Array<[string, string]> {
  return models.models.map(model => [model.id, model.label && model.label !== model.id ? `${model.label} (${model.id})` : model.id]);
}

/**
 * Step 3: one row per role. Provider choices come from the saved config;
 * models come from GET providers/:id/models with a manual entry fallback.
 * Budget and rate-limit fields appear only when the built-in router is used.
 */
export function renderRolesStep(context: RolesStepContextLike): HTMLElement {
  const section = node('section', 'onboarding-step-panel onboarding-roles-step');
  const config = context.config;
  const providers = providerOptions(config);
  const effective = effectiveRoles(config);
  const budgets = new Map(budgetRows(config).map(row => [row.role, row]));
  const draft: Record<string, RoleDraftEntry> = {};
  for (const role of roleIds(config)) {
    const value = effective[role] ?? { provider: '', model: '' };
    const budget = budgets.get(role);
    draft[role] = {
      provider: value.provider,
      model: value.model,
      ...(budget ? { budget: { usd: budget.usd, reset: budget.reset }, rateLimit: { requests: budget.requests, tokens: budget.tokens, reset: budget.rateReset } } : {}),
    };
  }
  drafts.set(section, draft);

  section.append(
    node('h2', '', 'A model for each part'),
    node('p', '', 'Pick a provider and model for every role. Models load from the provider at runtime; type an id if the list is unavailable.'),
  );
  const providerEntries: Array<[string, string]> = [['', 'Choose a provider'], ...providers.map(provider => [provider.id, provider.label] as [string, string])];
  const list = node('div', 'onboarding-role-editor');

  for (const role of roleIds(config)) {
    const definition = ROLE_DEFINITIONS.find(entry => entry.id === role)!;
    const row = node('article', 'onboarding-role');
    const head = node('div', 'onboarding-role-head');
    head.append(node('strong', '', definition.label), node('small', 'onboarding-hint', definition.detail));
    if (definition.required) head.append(node('span', 'onboarding-badge', 'required'));
    const own = config.roles?.[role];
    const inherits = Boolean(config.mode === 'minimal' && config.defaultModel?.provider && !(own?.provider && own?.model));
    if (inherits) head.append(node('span', 'onboarding-badge onboarding-inherits', 'inherits default model'));
    row.append(head);

    const loadModels = (value: string) => {
      if (!value) {
        modelSelect.replaceChildren(node('option', '', 'Choose a provider first'));
        return;
      }
      modelSelect.replaceChildren(node('option', '', 'Loading models…'));
      void context.api.listModels(value).then(result => {
        const entries = modelEntries(result);
        if (!entries.length) {
          modelSelect.replaceChildren(node('option', '', 'No model list; type one below'));
          manual.focus();
          return;
        }
        modelSelect.replaceChildren(...entries.map(([id, label]) => {
          const option = node('option', '', label);
          option.value = id;
          return option;
        }));
        const preferred = result.default && entries.some(([id]) => id === result.default) ? result.default : entries[0][0];
        modelSelect.value = draft[role].model && entries.some(([id]) => id === draft[role].model) ? draft[role].model : preferred;
        draft[role].model = modelSelect.value;
        manual.value = draft[role].model;
      }).catch(() => {
        modelSelect.replaceChildren(node('option', '', 'Model list unavailable; type one below'));
        context.notify('The model list was unavailable. Type a model id instead.', true);
      });
    };
    const providerSelect = selectField(providerEntries, draft[role].provider, `${definition.label} provider`, value => {
      draft[role].provider = value;
      draft[role].model = '';
      manual.placeholder = 'Model id';
      loadModels(value);
    });
    const modelSelect = node('select', 'onboarding-select');
    modelSelect.setAttribute('aria-label', `${definition.label} model`);
    modelSelect.append(node('option', '', draft[role].provider ? 'Loading models…' : 'Choose a provider first'));
    if (draft[role].model) {
      const option = node('option', '', draft[role].model);
      option.value = draft[role].model;
      modelSelect.append(option);
      modelSelect.value = draft[role].model;
    }
    modelSelect.addEventListener('change', () => {
      draft[role].model = modelSelect.value;
      manual.value = modelSelect.value;
    });
    const manual = node('input', 'onboarding-input onboarding-model-fallback') as HTMLInputElement;
    manual.type = 'text';
    manual.autocomplete = 'off';
    manual.placeholder = 'Model id (manual fallback)';
    manual.value = draft[role].model;
    manual.setAttribute('aria-label', `${definition.label} model id`);
    manual.addEventListener('input', () => {
      draft[role].model = manual.value.trim();
    });
    if (draft[role].provider) loadModels(draft[role].provider);
    const fields = node('div', 'onboarding-role-fields');
    fields.append(providerSelect, modelSelect, manual);
    if (config.mode === 'minimal' && config.defaultModel?.provider) {
      const clear = node('button', 'onboarding-secondary onboarding-clear-role', 'Inherit default model') as HTMLButtonElement;
      clear.type = 'button';
      clear.addEventListener('click', () => {
        draft[role] = { provider: '', model: '' };
        providerSelect.value = '';
        modelSelect.replaceChildren(node('option', '', 'Inherits the default model'));
        manual.value = '';
        context.notify(`${definition.label} now inherits the default model.`);
      });
      fields.append(clear);
    }
    row.append(fields);

    const budget = budgets.get(role);
    if (budget) {
      const budgetRow = node('div', 'onboarding-budget-row');
      const usd = node('input', 'onboarding-input onboarding-budget') as HTMLInputElement;
      usd.type = 'number';
      usd.min = '0';
      usd.step = '0.5';
      usd.value = String(budget.usd);
      usd.setAttribute('aria-label', `${definition.label} daily or monthly budget in USD`);
      const reset = node('input', 'onboarding-input onboarding-budget-reset') as HTMLInputElement;
      reset.type = 'text';
      reset.value = budget.reset;
      reset.setAttribute('aria-label', `${definition.label} budget reset interval`);
      const requests = node('input', 'onboarding-input onboarding-rate-limit') as HTMLInputElement;
      requests.type = 'number';
      requests.min = '0';
      requests.value = String(budget.requests);
      requests.setAttribute('aria-label', `${definition.label} requests per interval`);
      const tokens = node('input', 'onboarding-input onboarding-rate-limit') as HTMLInputElement;
      tokens.type = 'number';
      tokens.min = '0';
      tokens.value = String(budget.tokens);
      tokens.setAttribute('aria-label', `${definition.label} tokens per interval`);
      const update = () => {
        draft[role].budget = { usd: Number(usd.value) || 0, reset: reset.value.trim() || budget.reset };
        draft[role].rateLimit = { requests: Number(requests.value) || 0, tokens: Number(tokens.value) || 0, reset: budget.rateReset };
      };
      for (const input of [usd, reset, requests, tokens]) input.addEventListener('input', update);
      budgetRow.append(node('span', 'onboarding-field-label', 'Budget'), usd, reset, node('span', 'onboarding-field-label', 'Rate limit'), requests, tokens);
      row.append(budgetRow);
    }
    list.append(row);
  }
  section.append(list);
  if (budgetRows(config).length) {
    section.append(node('p', 'onboarding-note', 'Budget and rate-limit values apply only to the built-in router. Defaults: setup $2/day, chat $10/month, workers $20/month, summarize $2/month.'));
  }
  return section;
}
