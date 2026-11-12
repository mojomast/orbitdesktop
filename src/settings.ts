// Orbit Settings: the same install, provider, role and review components used
// by the first-run wizard, available after setup. Dark theme only.

import './settings.css';
import { createGithubApi, renderGithubSection, renderReposSection, type GithubApi } from './onboarding-github';
import {
  createOnboardingApi,
  type OnboardingApi,
  type OnboardingConfig,
  type OnboardingProvider,
  type OnboardingStateResponse,
} from './onboarding';
import {
  ROLE_DEFINITIONS,
  budgetRows,
  readRoleDraft,
  renderRolesStep,
  roleRows,
  validateRoles,
  type ProviderLike,
  type RoleDefinition,
} from './onboarding-roles';
import { renderReviewStep, reviewRunsText } from './onboarding-review';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function providerKind(kind: string): string {
  return kind === 'openai-compatible' ? 'OpenAI-compatible'
    : kind === 'opencode-free' ? 'OpenCode free'
    : kind === 'openrouter' ? 'OpenRouter'
    : kind === 'anthropic' ? 'Anthropic'
    : kind === 'router' ? 'Token router'
    : kind === 'pi' ? 'Pi'
    : kind;
}

function masked(provider: OnboardingProvider): string {
  return provider.key?.set ? (provider.key.masked ?? 'set') : 'not set';
}

export interface SettingsHandle {
  element: HTMLElement;
  refresh(): Promise<void>;
  close(): void;
}

/** Mount the Settings page. Components, providers, roles and mode are editable. */
export function mountSettings(root: HTMLElement, api: OnboardingApi = createOnboardingApi(), github: GithubApi = createGithubApi({ basePath: '/api/settings' })): SettingsHandle {
  const container = node('section', 'orbit-settings');
  container.setAttribute('aria-labelledby', 'orbit-settings-title');
  const title = node('h1', '', 'Orbit settings');
  title.id = 'orbit-settings-title';
  title.tabIndex = -1;
  const status = node('p', 'settings-status', '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const content = node('div', 'settings-content');
  container.append(title, content, status);
  let state: OnboardingStateResponse | null = null;
  let busy = false;

  function notify(message: string, error = false): void {
    status.textContent = message;
    status.dataset.error = String(error);
  }

  function config(): OnboardingConfig {
    return state!.config;
  }

  function providers(): ProviderLike[] {
    return state!.providers as ProviderLike[];
  }

  function context() {
    return { api, config: config(), providers: providers(), notify, refresh };
  }

  function section(heading: string, detail?: string): HTMLElement {
    const block = node('section', 'settings-section');
    block.append(node('h2', '', heading));
    if (detail) block.append(node('p', 'settings-hint', detail));
    return block;
  }

  function providerEditor(): HTMLElement {
    const block = section('Providers and keys', 'Keys are stored in 0600 files under the runtime directory. Only a masked value is shown here.');
    for (const provider of providers()) {
      const row = node('article', 'settings-provider');
      const head = node('div', 'settings-provider-head');
      head.append(
        node('strong', '', provider.label),
        node('span', 'onboarding-badge', providerKind(provider.kind)),
        node('span', 'settings-key-state', `Key: ${masked(provider)}`),
      );
      if (provider.kind === 'router' && !config().router.enabled) head.append(node('span', 'onboarding-badge', 'stored, inactive'));
      row.append(head);
      if (provider.baseUrl) row.append(node('p', 'settings-hint', provider.baseUrl));

      const actions = node('div', 'settings-provider-actions');
      const keyInput = node('input', 'onboarding-input settings-key-input') as HTMLInputElement;
      keyInput.type = 'password';
      keyInput.autocomplete = 'off';
      keyInput.spellcheck = false;
      keyInput.placeholder = provider.key?.set ? 'Replace key' : 'Paste key';
      keyInput.setAttribute('aria-label', `Replace API key for ${provider.label}`);
      const replace = node('button', 'onboarding-secondary', 'Replace key') as HTMLButtonElement;
      replace.type = 'button';
      replace.addEventListener('click', async () => {
        if (!keyInput.value) { notify('Enter a key before replacing it.', true); keyInput.focus(); return; }
        busy = true;
        try {
          state = await api.setProviderKey(provider.id, keyInput.value);
          keyInput.value = '';
          notify(`Key replaced for ${provider.label}.`);
          render();
        } catch (error) {
          keyInput.value = '';
          notify(error instanceof Error ? error.message : 'The key could not be saved.', true);
        } finally { busy = false; }
      });
      const clear = node('button', 'onboarding-secondary', 'Clear key') as HTMLButtonElement;
      clear.type = 'button';
      clear.addEventListener('click', async () => {
        busy = true;
        try {
          state = await api.clearProviderKey(provider.id);
          notify(`Key cleared for ${provider.label}.`);
          render();
        } catch (error) {
          notify(error instanceof Error ? error.message : 'The key could not be cleared.', true);
        } finally { busy = false; }
      });
      actions.append(keyInput, replace);
      if (provider.key?.set) actions.append(clear);
      row.append(actions);
      block.append(row);
    }

    const form = node('form', 'settings-provider-form');
    form.append(node('h3', '', 'Add a provider'));
    const id = node('input', 'onboarding-input') as HTMLInputElement;
    id.placeholder = 'local-models';
    id.autocomplete = 'off';
    id.setAttribute('aria-label', 'Provider id');
    const label = node('input', 'onboarding-input') as HTMLInputElement;
    label.placeholder = 'Local models';
    label.setAttribute('aria-label', 'Provider label');
    const baseUrl = node('input', 'onboarding-input') as HTMLInputElement;
    baseUrl.placeholder = 'http://127.0.0.1:8000/v1';
    baseUrl.autocomplete = 'off';
    baseUrl.setAttribute('aria-label', 'Provider base URL');
    const key = node('input', 'onboarding-input') as HTMLInputElement;
    key.type = 'password';
    key.autocomplete = 'off';
    key.spellcheck = false;
    key.placeholder = 'Optional now; can be saved later';
    key.setAttribute('aria-label', 'Provider API key');
    const kind = node('select', 'onboarding-select') as HTMLSelectElement;
    kind.setAttribute('aria-label', 'Provider kind');
    for (const [value, text] of [['openai-compatible', 'OpenAI-compatible'], ['openrouter', 'OpenRouter'], ['anthropic', 'Anthropic'], ['opencode-free', 'OpenCode free'], ['pi', 'Pi harness']]) {
      const option = node('option', '', text);
      option.value = value;
      kind.append(option);
    }
    form.append(id, label, kind, baseUrl, key);
    const add = node('button', 'onboarding-primary', 'Add provider') as HTMLButtonElement;
    add.type = 'submit';
    form.append(add);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const providerId = id.value.trim();
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(providerId) || !label.value.trim()) {
        notify('Provider id and label are required.', true);
        return;
      }
      busy = true;
      try {
        state = await api.addProvider({
          id: providerId,
          kind: kind.value,
          label: label.value.trim(),
          ...(baseUrl.value.trim() ? { baseUrl: baseUrl.value.trim() } : {}),
        });
        if (key.value) state = await api.setProviderKey(providerId, key.value);
        key.value = '';
        notify(`${label.value.trim()} added.`);
        render();
      } catch (error) {
        key.value = '';
        notify(error instanceof Error ? error.message : 'The provider could not be added.', true);
      } finally { busy = false; }
    });
    block.append(form);
    return block;
  }

  function componentsEditor(): HTMLElement {
    const block = section('What is installed', 'Only core is required. The built-in router is opt-in and off unless you select it.');
    const choices: Array<[string, string]> = [
      ['core', 'Orbit core'],
      ['pi', 'Pi agent harness'],
      ['opencode', 'OpenCode CLI'],
      ['hermes', 'Hermes runtime'],
      ['bundlebees', 'Bundlebees'],
      ['workerPairing', 'Worker pairing'],
      ['colab', 'Collab'],
      ['router', 'Token router (optional, off)'],
    ];
    let router = Boolean(config().components.router && config().router.enabled);
    const save = async (patch: Record<string, boolean>) => {
      busy = true;
      try {
        if (patch.router === false) {
          const confirmed = window.confirm('Turn the token router off? Generated router keys are deleted; your upstream provider keys are kept.');
          if (!confirmed) { render(); return; }
          state = await api.disableRouter();
          notify('Token router disabled. Generated keys were deleted; upstream keys were kept.');
        } else {
          state = await api.saveComponents({ ...config().components, ...patch }, patch.router === true ? { enabled: true, engine: config().router.engine } : undefined);
          notify('Install choices saved.');
        }
        render();
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Install choices could not be saved.', true);
      } finally { busy = false; }
    };
    for (const [key, label] of choices) {
      const row = node('label', 'settings-toggle');
      const input = node('input', 'onboarding-checkbox') as HTMLInputElement;
      input.type = 'checkbox';
      input.checked = key === 'router' ? router : Boolean(config().components[key]);
      input.disabled = key === 'core';
      input.dataset.setting = key;
      input.addEventListener('change', () => {
        if (key === 'router') router = input.checked;
        void save({ [key]: input.checked });
      });
      const copy = node('span', 'settings-toggle-copy');
      copy.append(node('strong', '', label));
      row.append(input, copy);
      block.append(row);
    }
    const apps = node('input', 'onboarding-input') as HTMLInputElement;
    apps.value = (config().components.apps ?? []).join(', ');
    apps.placeholder = 'Optional app ids, comma separated';
    apps.setAttribute('aria-label', 'Optional app ids');
    const saveApps = node('button', 'onboarding-secondary', 'Save app ids') as HTMLButtonElement;
    saveApps.type = 'button';
    saveApps.addEventListener('click', () => {
      const ids = apps.value.split(',').map(value => value.trim()).filter(Boolean);
      void save({ apps: ids as unknown as boolean });
    });
    block.append(apps, saveApps);
    return block;
  }

  function modeEditor(): HTMLElement {
    const block = section('Setup mode', 'Minimal install uses one provider and one model for every role. Custom maps each role separately.');
    const current = config().mode === 'minimal' ? 'minimal' : 'custom';
    block.append(node('p', '', `Current mode: ${current === 'minimal' ? 'Minimal install' : 'Custom'}`));
    if (current === 'minimal') {
      block.append(node('p', 'settings-hint', 'Every role inherits the default model until you override it. Switching to Custom writes the effective model into each role.'));
      const convert = node('button', 'onboarding-secondary', 'Switch to Custom') as HTMLButtonElement;
      convert.type = 'button';
      convert.addEventListener('click', async () => {
        busy = true;
        try {
          // The server calls switchToCustom and materializes the effective roles.
          state = await api.saveRoles({ mode: 'custom' });
          notify('Switched to Custom mode. Role models were kept as they were.');
          render();
        } catch (error) {
          notify(error instanceof Error ? error.message : 'Could not switch setup mode.', true);
        } finally { busy = false; }
      });
      block.append(convert);
    } else {
      const hint = node('p', 'settings-hint', config().defaultModel?.provider
        ? `Default model: ${config().defaultModel!.provider} · ${config().defaultModel!.model}. Switch to Minimal to inherit it again.`
        : 'Set a default model before switching to Minimal.');
      block.append(hint);
      if (config().defaultModel?.provider && config().defaultModel?.model) {
        const convert = node('button', 'onboarding-secondary', 'Switch to Minimal') as HTMLButtonElement;
        convert.type = 'button';
        convert.addEventListener('click', async () => {
          busy = true;
          try {
            state = await api.saveRoles({ mode: 'minimal', defaultModel: config().defaultModel });
            notify('Switched to Minimal install.');
            render();
          } catch (error) {
            notify(error instanceof Error ? error.message : 'Could not switch setup mode.', true);
          } finally { busy = false; }
        });
        block.append(convert);
      }
    }
    return block;
  }

  function rolesEditor(): HTMLElement {
    const block = section('Models by role', config().mode === 'minimal'
      ? 'Every role inherits default model until you override it. Edit a row to override just that role, then save.'
      : 'Choose the provider and model used for each part of Orbit.');
    const step = renderRolesStep(context());
    block.append(step);
    if (config().mode === 'minimal' && config().defaultModel?.provider) {
      const defaultRow = node('p', 'settings-default-model', `Default model: ${config().defaultModel?.provider ?? ''} · ${config().defaultModel?.model ?? ''}`);
      block.prepend(defaultRow);
    }
    if (budgetRows(config()).length) {
      block.append(node('p', 'settings-hint', 'Budget and rate-limit fields apply only to the built-in router.'));
    }
    const save = node('button', 'onboarding-primary', 'Save role mapping') as HTMLButtonElement;
    save.type = 'button';
    save.addEventListener('click', async () => {
      const draft = readRoleDraft(step);
      const roles = Object.fromEntries(Object.entries(draft).map(([role, entry]) => [role, { provider: entry.provider, model: entry.model }]));
      const validation = validateRoles(config(), roles);
      if (!validation.ok) {
        notify(validation.errors[0] ?? 'Choose a provider and model for each required role.', true);
        return;
      }
      const budgets = Object.fromEntries(Object.entries(draft).filter(([, entry]) => entry.budget).map(([role, entry]) => [role, { ...entry.budget, rateLimit: entry.rateLimit }]));
      busy = true;
      try {
        state = await api.saveRoles({
          roles,
          ...(Object.keys(budgets).length ? { budgets } : {}),
          ...(config().mode === 'minimal' ? { mode: 'minimal' } : {}),
        });
        notify('Role mapping saved.');
        render();
      } catch (error) {
        notify(error instanceof Error ? error.message : 'The role mapping could not be saved.', true);
      } finally { busy = false; }
    });
    block.append(save);
    if (config().router.enabled && config().router.mode !== 'external') {
      const rotate = node('button', 'onboarding-secondary', 'Rotate router keys') as HTMLButtonElement;
      rotate.type = 'button';
      rotate.addEventListener('click', async () => {
        if (!window.confirm('Rotate the generated token-router keys? Agents pick up the new keys after the router restarts.')) return;
        busy = true;
        try {
          const result = await api.rotateRouterKeys();
          notify(`Rotated router keys for ${result.rotated.join(', ')}.`);
        } catch (error) {
          notify(error instanceof Error ? error.message : 'Router keys could not be rotated.', true);
        } finally { busy = false; }
      });
      block.append(rotate);
    }
    const routerNote = node('p', 'settings-hint', `Running locally: ${reviewRunsText(config())}.`);
    block.append(routerNote);
    return block;
  }

  function githubEditor(): HTMLElement {
    const block = node('section', 'settings-section settings-github');
    block.append(renderGithubSection({ api: github, notify, heading: 'h2' }));
    return block;
  }

  function reposEditor(): HTMLElement {
    const block = node('section', 'settings-section settings-repos');
    const repos = renderReposSection({ api: github, notify, heading: 'h2' });
    const save = node('button', 'onboarding-primary', 'Save repositories') as HTMLButtonElement;
    save.type = 'button';
    save.setAttribute('aria-label', 'Save repositories to watch');
    save.addEventListener('click', async () => {
      try {
        const saved = await repos.save();
        notify(saved.length ? `Watching ${saved.length} ${saved.length === 1 ? 'repository' : 'repositories'}.` : 'No repositories are watched.');
      } catch (error) {
        notify(error instanceof Error ? error.message : 'The repositories could not be saved.', true);
      }
    });
    block.append(repos.element, save);
    return block;
  }

  function render(): void {
    if (!state) return;
    content.replaceChildren(componentsEditor(), providerEditor(), modeEditor(), rolesEditor(), githubEditor(), reposEditor());
    const review = node('section', 'settings-section');
    review.append(node('h2', '', 'Summary'));
    review.append(renderReviewStep(context() as never));
    content.append(review);
    for (const control of Array.from(content.querySelectorAll<HTMLButtonElement>('button'))) control.disabled = busy || control.disabled;
    title.focus();
  }

  async function refresh(): Promise<void> {
    try {
      state = await api.getState();
      render();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Settings are unavailable.', true);
    }
  }

  root.append(container);
  void refresh();
  return { element: container, refresh, close() { container.remove(); } };
}

export { ROLE_DEFINITIONS, roleRows, type RoleDefinition };
