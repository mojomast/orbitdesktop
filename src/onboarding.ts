import { el, button } from './dom';
import './onboarding.css';

const key = 'orbit.onboarding.v1';
const steps = [
  {title: 'Welcome to Orbit', text: ['A workspace you can shape with Hermes. Keep chats, terminals, websites and custom apps together—in a desktop or a navigable 3D scene.', 'This short tour only explains the controls. It will not rearrange windows, run commands or send messages. Reopen it anytime from Start → Getting started.']},
  {title: 'Your everyday controls', text: ['Start opens chats, terminals, browsers and searchable actions. The bottom taskbar switches windows and restores minimized ones. Drag window title bars to move them and their resize handles to change their size.', 'Use the upper-left view switcher for Windows or Spatial. Controls shows or hides workspace controls; Ctrl+Alt+F is another way back. The side panel contains settings for your selected window.']},
  {title: 'Move into 3D', text: ['In Spatial, drag a title bar to move a window; Shift-drag changes depth and Ctrl/Command-drag rotates it. The bottom-right handle resizes it. Arrange / edit provides grid, row and curved-wall tiling.', 'Navigate enables WASD or arrow-key travel and Q/E vertical movement. Drag the background to orbit, Shift-drag to pan, and scroll to zoom. Escape returns to interacting with apps. Fit all recovers your view; Approach brings a window closer.', 'Desktop text size and 3D text size are independent. Higher surface resolution fits more content; increase 3D text size or move closer for readability. Remote desktop streams have their own resolution limits.']},
  {title: 'Keep layouts for different tasks', text: ['Open Saved workspace layouts from Start or the command palette to save existing-window geometry and placement. Preview before applying; map missing window IDs explicitly. Applying preserves current panes and contents.', 'The older layout switcher at the bottom right keeps a separate browser-local collection. New from current saves that local layout; clearing browser storage removes it.', 'Neither kind of layout is a backup of documents, conversations or running processes. Workspace checkpoints provide separate layout/plugin recovery.']},
  {title: 'Use the built-in tools', text: ['Start and the command palette open Knowledge search, Interactive results, Voice transcript, Data workbench, Document library and Run traces. Import sources or files explicitly, save documents and canvases, and review content before inserting it into a chosen conversation draft.', 'Local models and data extensions need provisioning. Browser copilot and MCP Apps appear when configured; opening a surface does not execute an action. Conversation library keeps Orbit titles, pins and archives; drafts are host-backed with local recovery. Inserting or restoring a draft never sends it.'], prompt: 'Help me choose Orbit’s built-in tools for my task. Reuse existing surfaces, explain any setup requirements, preserve my windows and leave imported content and conversation drafts for my review.'},
  {title: 'Ask Hermes to make it yours', text: ['Open Start → Chat and describe the result you want in plain language. Specify which windows to change, what to preserve, and how you want the result checked.', 'Hermes can use workspace controls for layout, appearance and plugin settings. New core features may need source changes, a build and a reload. Layout context is not access to your screen pixels, terminal buffers or every embedded app.'], prompt: 'Make this a focused coding workspace: put my terminal on the left and chat on the right, use a dark background, and preserve my existing panes and running sessions. Save a checkpoint before changing the layout and verify the result.'},
  {title: 'Build apps inside your workspace', text: ['Describe the app, its controls, data source and how you will use it. Ask Hermes to build, publish and test it—not just provide a mockup. Then iterate by asking for specific changes.', 'Generated app plugins run in sandboxed browser panes, without a privileged host bridge. Host integrations need a separately authorized service. Never paste API keys into chat or store secrets in app code or plugin config.'], prompt: 'Build a focus timer app in this workspace with start, pause, reset and adjustable work/break durations. Keep it self-contained, publish it as a sandboxed plugin, test the controls, and add it without replacing my other windows.'},
  {title: 'Explore with a safety net', text: ['Ask for a preview and checkpoint before a big workspace redesign. Workspace checkpoints restore supported layout, appearance and plugin settings—not files, shell commands, messages, documents or running processes.', 'Review tool approvals and ask before destructive or external actions. Core code and browser-local named layouts need their own backups.', 'You’re ready. Open Start → Chat when you want help, or reopen Getting started anytime. Example prompts in this tour are copied only when you choose; nothing is sent automatically.']},
];
let active: HTMLDialogElement | undefined;
export type OnboardingActions = { connected:()=>boolean; run:(id:string)=>void };

export function showOnboarding(actions?:OnboardingActions) {
  if (active?.open) return;
  const previous = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.className = 'orbit-onboarding'; active = dialog;
  dialog.setAttribute('aria-labelledby', 'orbit-tour-title');
  const top = el('div', 'tour-top');
  const progress = el('span', 'tour-progress');
  const heading = el('h1'); heading.id = 'orbit-tour-title'; heading.tabIndex = -1;
  const content = el('div', 'tour-content');
  const status = el('p', 'tour-status'); status.setAttribute('role', 'status');
  const footer = el('div', 'tour-footer');
  let index = 0;
  try { const saved=Number(sessionStorage.getItem(`${key}.step`));if(Number.isInteger(saved)&&saved>=0&&saved<steps.length)index=saved; } catch {}
  function finish() {
    try { localStorage.setItem(key, 'done'); sessionStorage.removeItem(`${key}.step`); } catch { /* Tour still works without persistence. */ }
    dialog.close();
  }
  const back = button('Back', 'Previous tour step', () => { index--; render(); });
  const next = button('Next', 'Next tour step', () => { if (index === steps.length - 1) finish(); else { index++; render(); } });
  top.append(el('strong', '', '◉ ORBIT / GETTING STARTED'), button('Close for now', 'Close getting started', () => dialog.close()), button('Skip tour', 'Skip tour', finish));
  footer.append(back, progress, next);
  function render() {
    try { sessionStorage.setItem(`${key}.step`,String(index)); } catch {}
    const step = steps[index];
    heading.textContent = step.title;
    progress.textContent = `${index + 1} of ${steps.length}`;
    back.disabled = index === 0;
    next.textContent = index === steps.length - 1 ? 'Start exploring' : 'Next';
    next.setAttribute('aria-label', index === steps.length - 1 ? 'Finish tour' : 'Next tour step');
    content.replaceChildren(...step.text.map(text => el('p', '', text)));
    if(index===0 && actions){
      heading.textContent='What would you like to do?';
      content.replaceChildren(el('p','',actions.connected()?'Host token is present. Each tool checks its actual connection and assets when opened.':'Connect the host to chat or save private work. Local file analysis and voice setup can be explored first.'));
      for(const [label,id,detail] of [
        ['Connect host','connect-host','Unlock this browser session with your host token.'],
        ['Chat with Hermes',actions.connected()?'new-agent':'connect-host',actions.connected()?'Open chat and check its binding status before sending.':'Connect host first, then open Chat from Start.'],
        ['Transcribe audio','technology-voice','Readiness not checked. Open Voice transcript and use Check local model for local asset status and provisioning instructions.'],
        ['Analyze a file','technology-data','Open Data workbench, choose your file and inspect engine readiness. CSV is local; JSON/Parquet need provisioned extensions.'],
      ])content.append(button(label,`${label}: ${detail}`,()=>{dialog.close();actions.run(id);}),el('p','',detail));
      content.append(el('p','','Opening these tools does not send a message, start recording or provision models. Choose Next for the controls tour.'));
    }
    status.textContent = '';
    if (step.prompt) {
      const prompt = el('textarea', 'tour-prompt') as HTMLTextAreaElement;
      prompt.readOnly = true; prompt.value = step.prompt; prompt.setAttribute('aria-label', 'Example prompt');
      const copy = button('Copy example prompt', 'Copy example prompt', async () => {
        try { await navigator.clipboard.writeText(step.prompt!); status.textContent = 'Copied. Paste into an agent chat and review before sending.'; }
        catch { prompt.focus(); prompt.select(); status.textContent = 'Copy unavailable. The prompt is selected; use your usual copy shortcut.'; }
      });
      content.append(prompt, copy);
    }
    heading.focus(); content.scrollTop = 0;
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  dialog.addEventListener('close', () => {
    // Dismissal is not completion, but must not interrupt the next reconnect.
    // Getting started still resumes the separately retained step on demand.
    try { if(localStorage.getItem(key)!=='done')localStorage.setItem(key,'dismissed'); } catch {}
    dialog.remove(); active = undefined; if (previous?.isConnected) previous.focus();
  });
  dialog.append(top, heading, content, status, footer);
  document.body.append(dialog); dialog.showModal(); render();
}

export function offerOnboarding(actions?:OnboardingActions) {
  let seen = false;
  try { seen = ['done','dismissed'].includes(localStorage.getItem(key) || ''); } catch { /* Nonpersistent first run. */ }
  if (!seen) showOnboarding(actions);
}

// ---------------------------------------------------------------------------
// First-run configuration wizard (owner setup: components, providers, keys).
//
// Steps 1 and 2 are implemented here. The role/model step and the review step
// are exported hooks so the next slice can complete them without rewriting the
// shell. Only masked key state from the server ever reaches this module.

export type RouterEngine = 'bifrost' | 'litellm';
export type ProviderMode = 'direct' | 'builtin' | 'external';

export interface OnboardingProviderKey {
  set: boolean;
  masked: string | null;
}

export interface OnboardingProvider {
  id: string;
  kind: string;
  label: string;
  baseUrl?: string;
  routerType?: 'hosted' | 'self-hosted';
  privacyNote?: string;
  active?: boolean;
  keyRef?: { file?: string; env?: string };
  key?: OnboardingProviderKey;
}

export interface OnboardingRoleChoice {
  provider: string;
  model: string;
}

export interface OnboardingRouterView {
  enabled: boolean;
  mode: 'builtin' | 'external';
  engine: RouterEngine;
  image?: string;
  bind: 'internal' | 'loopback';
  port: number;
  contentLogging?: boolean;
  allowPrivateNetwork?: boolean;
  virtualKeys?: Array<{ role: string; keyRef?: { file?: string } }>;
  external?: { baseUrl?: string; keyRef?: { file?: string } };
}

export interface OnboardingComponents {
  core: boolean;
  pi: boolean;
  opencode: boolean;
  hermes: boolean;
  bundlebees: boolean;
  workerPairing: boolean;
  colab: boolean;
  router: boolean;
  apps: string[];
  [key: string]: boolean | string[];
}

export interface OnboardingConfig {
  schemaVersion: number;
  providerMode?: 'direct' | 'router';
  components: OnboardingComponents;
  providers: OnboardingProvider[];
  roles: Record<string, OnboardingRoleChoice>;
  router: OnboardingRouterView;
  appliedAt?: string;
  installState?: Record<string, 'pending' | 'installed' | 'failed' | 'skipped'>;
}

export interface OnboardingStateResponse {
  ok: boolean;
  config: OnboardingConfig;
  providers: OnboardingProvider[];
  error?: string;
  routerSupervisor?: { applied: boolean };
}

export interface OnboardingModel {
  id: string;
  label: string;
  privacyNote?: string;
}

export interface OnboardingModelList {
  ok: boolean;
  providerId?: string;
  models: OnboardingModel[];
  manual: boolean;
  default?: string;
}

export interface OnboardingOpenCodeState {
  ok: boolean;
  opencode: { installed: boolean; path: string | null; version: string | null };
  install: { command: string; requiresConfirm: true };
}

export interface OnboardingApi {
  getState(): Promise<OnboardingStateResponse>;
  saveComponents(components: OnboardingComponents, router?: Record<string, unknown>): Promise<OnboardingStateResponse>;
  addProvider(provider: OnboardingProvider, router?: Record<string, unknown>): Promise<OnboardingStateResponse>;
  deleteProvider(id: string): Promise<OnboardingStateResponse>;
  setProviderKey(id: string, key: string): Promise<OnboardingStateResponse>;
  clearProviderKey(id: string): Promise<OnboardingStateResponse>;
  detectOpencode(): Promise<OnboardingOpenCodeState>;
  installOpencode(confirm: boolean): Promise<OnboardingOpenCodeState & { installed?: boolean }>;
  listModels(id: string): Promise<OnboardingModelList>;
  apply(): Promise<OnboardingStateResponse & { applied?: boolean }>;
}

export interface OnboardingStepContext {
  api: OnboardingApi;
  config: OnboardingConfig;
  providers: OnboardingProvider[];
  refresh(): Promise<void>;
  notify(message: string, error?: boolean): void;
}

export function createOnboardingApi(options: {
  basePath?: string;
  fetchImpl?: typeof fetch;
  token?: string;
  getToken?: () => string | null | undefined;
} = {}): OnboardingApi {
  const basePath = (options.basePath ?? '/api/onboarding').replace(/\/+$/, '');
  const request = async <T>(method: string, pathname: string, body?: unknown): Promise<T> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const token = options.getToken ? options.getToken() : options.token;
    const response = await fetchImpl(`${basePath}${pathname}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: any = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok || data?.ok === false) throw new Error(typeof data?.error === 'string' ? data.error : 'Orbit setup request failed.');
    return data as T;
  };
  const idPath = (id: string) => `/providers/${encodeURIComponent(id)}`;
  return {
    getState: () => request<OnboardingStateResponse>('GET', '/state'),
    saveComponents: (components, router) => request<OnboardingStateResponse>('PUT', '/components', { components, ...(router ? { router } : {}) }),
    addProvider: (provider, router) => request<OnboardingStateResponse>('POST', '/providers', { provider, ...(router ? { router } : {}) }),
    deleteProvider: id => request<OnboardingStateResponse>('DELETE', idPath(id)),
    setProviderKey: (id, key) => request<OnboardingStateResponse>('POST', `${idPath(id)}/key`, { key }),
    clearProviderKey: id => request<OnboardingStateResponse>('DELETE', `${idPath(id)}/key`),
    detectOpencode: () => request<OnboardingOpenCodeState>('GET', '/opencode'),
    installOpencode: confirm => request<OnboardingOpenCodeState & { installed?: boolean }>('POST', '/opencode/install', { confirm }),
    listModels: id => request<OnboardingModelList>('GET', `${idPath(id)}/models`),
    apply: () => request<OnboardingStateResponse & { applied?: boolean }>('POST', '/apply', {}),
  };
}

const COMPONENT_CHOICES: Array<['pi' | 'opencode' | 'hermes' | 'bundlebees' | 'workerPairing' | 'colab', string, string]> = [
  ['pi', 'Pi agent harness', 'Optional agent adapter. Orbit can use an existing Pi install or a configured Pi gateway.'],
  ['opencode', 'OpenCode CLI', 'Optional coding agent. Free OpenCode models run only through this client.'],
  ['hermes', 'Hermes runtime', 'Optional primary runtime when you already run a Hermes gateway.'],
  ['bundlebees', 'Bundlebees', 'Optional worker tooling for bundled model tasks.'],
  ['workerPairing', 'Worker pairing', 'Optional pairing for local worker machines.'],
  ['colab', 'Collab', 'Optional project board for coordinating several agents.'],
];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function choiceField(options: Array<[string, string]>, value: string, change: (value: string) => void, label?: string): HTMLSelectElement {
  const select = element('select', 'onboarding-select');
  if (label) select.setAttribute('aria-label', label);
  for (const [optionValue, optionLabel] of options) {
    const option = element('option', '', optionLabel);
    option.value = optionValue;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => change(select.value));
  return select;
}

function labelled(text: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const wrapper = element('label', 'onboarding-field');
  wrapper.append(element('span', 'onboarding-field-label', text), control);
  if (hint) wrapper.append(element('small', 'onboarding-hint', hint));
  return wrapper;
}

function toggleRow(key: string, title: string, detail: string, checked: boolean, disabled: boolean, change: (checked: boolean) => void): HTMLLabelElement {
  const wrapper = element('label', 'onboarding-toggle');
  const input = element('input', 'onboarding-checkbox') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  input.dataset.setting = key;
  input.addEventListener('change', () => change(input.checked));
  const copy = element('span', 'onboarding-toggle-copy');
  copy.append(element('strong', '', title), element('small', '', detail));
  wrapper.append(input, copy);
  return wrapper;
}

function maskedKey(provider: OnboardingProvider): string {
  return provider.key?.set ? (provider.key.masked ?? 'set') : 'not set';
}

function providerKindLabel(kind: string): string {
  return kind === 'openai-compatible' ? 'OpenAI-compatible'
    : kind === 'opencode-free' ? 'OpenCode free'
    : kind === 'openrouter' ? 'OpenRouter'
    : kind === 'anthropic' ? 'Anthropic'
    : kind === 'router' ? 'Token router'
    : kind === 'pi' ? 'Pi'
    : kind;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function rolePlaceholder(context: OnboardingStepContext): HTMLElement {
  const section = element('section', 'onboarding-step-panel');
  section.append(
    element('h2', '', 'A model for each part'),
    element('p', '', 'Choose the provider and model used for setup, chat, workers and summaries. This step is completed by the workspace setup flow; the choices are saved in orbit-config.json and can be edited later in Settings.'),
  );
  const list = element('dl', 'onboarding-role-list');
  for (const role of ['setup', 'chat', 'workers', 'summarize']) {
    const value = context.config.roles?.[role];
    list.append(
      element('dt', '', role[0].toUpperCase() + role.slice(1)),
      element('dd', '', value?.provider ? `${value.provider} · ${value.model || 'choose a model'}` : 'Not chosen yet'),
    );
  }
  const budgets = element('div', 'onboarding-note');
  budgets.append(
    element('strong', '', 'Default router budgets'),
    element('p', '', 'Setup $2/day · chat $10/month · workers $20/month · summarize $2/month. These are editable with the role mapping and apply only when the built-in router is enabled.'),
  );
  section.append(list, budgets);
  return section;
}

function reviewPlaceholder(context: OnboardingStepContext): HTMLElement {
  const section = element('section', 'onboarding-step-panel');
  const enabled = Object.entries(context.config.components)
    .filter(([key, value]) => key !== 'apps' && value === true)
    .map(([key]) => key);
  section.append(
    element('h2', '', 'Review and apply'),
    element('p', '', 'Applying records these choices. The setup agent then installs only the components you selected; later changes stay available in Settings.'),
  );
  const summary = element('dl', 'onboarding-review-list');
  summary.append(
    element('dt', '', 'Components'), element('dd', '', enabled.join(', ') || 'core'),
    element('dt', '', 'Provider path'), element('dd', '', context.config.router.enabled ? (context.config.router.mode === 'external' ? 'External router' : 'Built-in token router') : 'Direct providers'),
    element('dt', '', 'Providers'), element('dd', '', context.providers.filter(provider => provider.kind !== 'router').map(provider => provider.label).join(', ') || 'None yet'),
    element('dt', '', 'Applied'), element('dd', '', context.config.appliedAt ?? 'Not yet'),
  );
  if (context.config.router.enabled) {
    summary.append(element('dt', '', 'Token router'), element('dd', '', `${context.config.router.engine === 'litellm' ? 'LiteLLM' : 'Bifrost'} · ${context.config.router.bind === 'loopback' ? `127.0.0.1:${context.config.router.port}` : `internal :${context.config.router.port}`} · content logging off`));
  }
  section.append(summary, element('p', 'onboarding-note', 'Nothing router-related runs unless the token router was selected in step 1.'));
  return section;
}

/** Slice OF2 replaces this hook with editable role/provider/model and budget controls. */
export function renderRolesStep(context: OnboardingStepContext): HTMLElement {
  return rolePlaceholder(context);
}

/** Slice OF2 replaces this hook with the final editable review and apply summary. */
export function renderReviewStep(context: OnboardingStepContext): HTMLElement {
  return reviewPlaceholder(context);
}

export interface OnboardingWizardHandle {
  element: HTMLElement;
  refresh(): Promise<void>;
  close(): void;
}

export function mountOnboarding(root: HTMLElement, api: OnboardingApi = createOnboardingApi()): OnboardingWizardHandle {
  const wizard = element('section', 'orbit-setup-wizard');
  wizard.setAttribute('aria-labelledby', 'orbit-setup-title');
  const top = element('div', 'onboarding-top');
  const title = element('h1', '', 'Set up Orbit');
  title.id = 'orbit-setup-title';
  title.tabIndex = -1;
  const progress = element('ol', 'onboarding-progress');
  const progressItems = ['Install', 'Providers & keys', 'Models', 'Review'].map((label, index) => {
    const item = element('li', '', `${index + 1}. ${label}`);
    item.dataset.step = String(index);
    progress.append(item);
    return item;
  });
  top.append(title, progress);
  const content = element('div', 'onboarding-content');
  const status = element('p', 'onboarding-status', '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const footer = element('div', 'onboarding-footer');
  const back = element('button', 'onboarding-secondary', 'Back') as HTMLButtonElement;
  back.type = 'button';
  const next = element('button', 'onboarding-primary', 'Continue') as HTMLButtonElement;
  next.type = 'button';
  const stepLabel = element('span', 'onboarding-step-label', '');
  footer.append(back, stepLabel, next);
  wizard.append(top, content, status, footer);

  let state: OnboardingStateResponse | null = null;
  let step = 0;
  let busy = false;
  let applied = false;
  let mode: ProviderMode = 'direct';
  let commitStepOne: (() => Promise<void>) | null = null;

  function notify(message: string, error = false): void {
    status.textContent = message;
    status.dataset.error = String(error);
  }

  function setBusy(value: boolean, message?: string): void {
    busy = value;
    back.disabled = value || step === 0;
    next.disabled = value || applied;
    if (message) notify(message);
  }

  function updateProgress(): void {
    for (const item of progressItems) {
      const index = Number(item.dataset.step);
      item.dataset.current = String(index === step);
      item.dataset.done = String(index < step);
      if (index === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
    stepLabel.textContent = `Step ${step + 1} of ${progressItems.length}`;
    next.textContent = step === progressItems.length - 1 ? (applied ? 'Applied' : 'Apply choices') : 'Continue';
    next.setAttribute('aria-label', step === progressItems.length - 1 ? 'Apply setup choices' : 'Continue to the next setup step');
  }

  async function refresh(): Promise<void> {
    try {
      state = await api.getState();
      mode = state.config.router.enabled
        ? (state.config.router.mode === 'external' ? 'external' : 'builtin')
        : 'direct';
      render();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Orbit setup is unavailable.', true);
    }
  }

  function context(): OnboardingStepContext {
    return {
      api,
      config: state!.config,
      providers: state!.providers,
      refresh,
      notify,
    };
  }

  function renderProviderRows(options: { includeRouter?: boolean; showPrivate?: boolean; allowDelete?: boolean; excludeKinds?: string[] } = {}): HTMLElement {
    const list = element('div', 'onboarding-provider-list');
    const providers = state!.providers.filter(provider => (options.includeRouter || provider.kind !== 'router') && !options.excludeKinds?.includes(provider.kind));
    if (!providers.length) {
      list.append(element('p', 'onboarding-empty', 'No providers yet.'));
      return list;
    }
    for (const provider of providers) {
      const row = element('article', 'onboarding-provider');
      const head = element('div', 'onboarding-provider-head');
      const identity = element('div', 'onboarding-provider-identity');
      identity.append(element('strong', '', provider.label), element('span', 'onboarding-badge', providerKindLabel(provider.kind)));
      if (!provider.active && provider.kind === 'router') identity.append(element('span', 'onboarding-badge', 'stored, inactive'));
      const key = element('span', 'onboarding-key-state', `Key: ${maskedKey(provider)}`);
      head.append(identity, key);
      row.append(head);
      if (provider.baseUrl) row.append(element('p', 'onboarding-provider-url', provider.baseUrl));
      if (provider.privacyNote) row.append(element('p', 'onboarding-hint', provider.privacyNote));

      const actions = element('div', 'onboarding-provider-actions');
      const keyInput = element('input', 'onboarding-key-input') as HTMLInputElement;
      keyInput.type = 'password';
      keyInput.autocomplete = 'off';
      keyInput.spellcheck = false;
      keyInput.placeholder = provider.key?.set ? 'Replace key' : 'Paste key';
      keyInput.setAttribute('aria-label', `API key for ${provider.label}`);
      const saveKey = element('button', 'onboarding-secondary', 'Save key') as HTMLButtonElement;
      saveKey.type = 'button';
      saveKey.addEventListener('click', async () => {
        if (!keyInput.value) {
          notify('Enter a key before saving.', true);
          keyInput.focus();
          return;
        }
        setBusy(true, 'Saving key…');
        try {
          state = await api.setProviderKey(provider.id, keyInput.value);
          keyInput.value = '';
          notify(`Key saved for ${provider.label}.`);
          render();
        } catch (error) {
          keyInput.value = '';
          notify(error instanceof Error ? error.message : 'The key could not be saved.', true);
        } finally {
          setBusy(false);
        }
      });
      actions.append(keyInput, saveKey);
      if (provider.key?.set) {
        const clear = element('button', 'onboarding-secondary', 'Clear key') as HTMLButtonElement;
        clear.type = 'button';
        clear.addEventListener('click', async () => {
          setBusy(true, 'Clearing key…');
          try {
            state = await api.clearProviderKey(provider.id);
            notify(`Key cleared for ${provider.label}.`);
            render();
          } catch (error) {
            notify(error instanceof Error ? error.message : 'The key could not be cleared.', true);
          } finally {
            setBusy(false);
          }
        });
        actions.append(clear);
      }
      if (options.allowDelete) {
        const remove = element('button', 'onboarding-danger', 'Remove provider') as HTMLButtonElement;
        remove.type = 'button';
        remove.addEventListener('click', async () => {
          setBusy(true, 'Removing provider…');
          try {
            state = await api.deleteProvider(provider.id);
            notify(`Removed ${provider.label}.`);
            render();
          } catch (error) {
            notify(error instanceof Error ? error.message : 'The provider could not be removed.', true);
          } finally {
            setBusy(false);
          }
        });
        actions.append(remove);
      }
      if (options.showPrivate) {
        const privateLabel = element('label', 'onboarding-inline-toggle');
        const privateInput = element('input', 'onboarding-checkbox') as HTMLInputElement;
        privateInput.type = 'checkbox';
        privateInput.checked = Boolean(state!.config.router.allowPrivateNetwork);
        privateInput.setAttribute('aria-label', `Allow private network for ${provider.label}`);
        privateInput.addEventListener('change', async () => {
          setBusy(true, 'Saving network policy…');
          try {
            state = await api.saveComponents(state!.config.components, {
              enabled: state!.config.router.enabled,
              engine: state!.config.router.engine,
              allowPrivateNetwork: privateInput.checked,
            });
            notify(privateInput.checked ? 'Private-network upstreams allowed. Use only for a loopback or local server you control.' : 'Private-network upstreams blocked.');
            render();
          } catch (error) {
            notify(error instanceof Error ? error.message : 'The network policy could not be saved.', true);
          } finally {
            setBusy(false);
          }
        });
        privateLabel.append(privateInput, document.createTextNode(' Allow private network (loopback/LAN only)'));
        row.append(element('p', 'onboarding-hint', 'This policy applies to the router as a whole. Keep it off unless every upstream is one you control.'));
        row.append(privateLabel);
      }
      row.append(actions);
      list.append(row);
    }
    return list;
  }

  function addProviderForm(options: { excludeKinds?: string[]; title?: string } = {}): HTMLElement {
    const form = element('form', 'onboarding-provider-form');
    form.append(element('h3', '', options.title ?? 'Add a provider'));
    const allDirectKinds: Array<[string, string]> = [
      ['openai-compatible', 'OpenAI-compatible'],
      ['openrouter', 'OpenRouter'],
      ['anthropic', 'Anthropic'],
      ['opencode-free', 'OpenCode free'],
      ['pi', 'Pi harness'],
    ];
    const directKinds = allDirectKinds.filter(([kind]) => !options.excludeKinds?.includes(kind));
    let kind = directKinds[0]?.[0] ?? 'openai-compatible';
    const kindSelect = choiceField(directKinds, kind, value => { kind = value; }, 'Provider kind');
    const id = element('input', 'onboarding-input') as HTMLInputElement;
    id.placeholder = 'local-models';
    id.autocomplete = 'off';
    id.setAttribute('aria-label', 'Provider id');
    const label = element('input', 'onboarding-input') as HTMLInputElement;
    label.placeholder = 'Local models';
    label.setAttribute('aria-label', 'Provider label');
    const baseUrl = element('input', 'onboarding-input') as HTMLInputElement;
    baseUrl.placeholder = 'http://127.0.0.1:8000/v1';
    baseUrl.autocomplete = 'off';
    baseUrl.setAttribute('aria-label', 'Provider base URL');
    const key = element('input', 'onboarding-input') as HTMLInputElement;
    key.type = 'password';
    key.autocomplete = 'off';
    key.spellcheck = false;
    key.placeholder = 'Optional now; can be saved later';
    key.setAttribute('aria-label', 'Provider API key');
    const note = element('input', 'onboarding-input') as HTMLInputElement;
    note.placeholder = 'Optional privacy note shown with this provider';
    note.setAttribute('aria-label', 'Provider privacy note');
    form.append(
      labelled('Kind', kindSelect),
      labelled('Id', id, 'Lowercase letters, digits and dashes, up to 32 characters.'),
      labelled('Label', label),
      labelled('Base URL', baseUrl, 'The OpenAI-compatible base URL, usually ending in /v1. Loopback is allowed.'),
      labelled('API key', key, 'The key is stored server-side in a 0600 file and only a masked value is returned here.'),
      labelled('Privacy note', note),
    );
    const add = element('button', 'onboarding-primary', 'Add provider') as HTMLButtonElement;
    add.type = 'submit';
    form.append(add);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const providerId = id.value.trim();
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(providerId)) {
        notify('Provider id must use lowercase letters, digits and dashes.', true);
        id.focus();
        return;
      }
      if (!label.value.trim()) {
        notify('Give the provider a label.', true);
        label.focus();
        return;
      }
      const provider: OnboardingProvider = {
        id: providerId,
        kind,
        label: label.value.trim(),
        ...(baseUrl.value.trim() ? { baseUrl: baseUrl.value.trim() } : {}),
        ...(note.value.trim() ? { privacyNote: note.value.trim() } : {}),
      };
      setBusy(true, 'Adding provider…');
      try {
        state = await api.addProvider(provider);
        if (key.value) state = await api.setProviderKey(providerId, key.value);
        key.value = '';
        notify(`${provider.label} added.`);
        render();
      } catch (error) {
        key.value = '';
        notify(error instanceof Error ? error.message : 'The provider could not be added.', true);
      } finally {
        setBusy(false);
      }
    });
    return form;
  }

  function directPanel(): HTMLElement {
    const panel = element('section', 'onboarding-panel');
    panel.append(
      element('h3', '', 'Direct providers'),
      element('p', '', 'Talk to each provider directly. Keys stay in the runtime keys directory; the configuration file only stores a reference.'),
      renderProviderRows({ allowDelete: true }),
      element('p', 'onboarding-hint', 'OpenCode free models stay direct and run only through the OpenCode client.'),
      addProviderForm(),
    );
    return panel;
  }

  function builtinPanel(): HTMLElement {
    const router = state!.config.router;
    const panel = element('section', 'onboarding-panel');
    const endpoint = router.bind === 'loopback' ? `http://127.0.0.1:${router.port}/v1` : `http://router:${router.port}/v1`;
    panel.append(
      element('h3', '', 'Built-in token router'),
      element('p', '', `One local OpenAI-compatible endpoint (${endpoint}) routes to the upstream providers below. ${router.engine === 'litellm' ? 'LiteLLM' : 'Bifrost'} is pinned by image digest; content logging stays off.`),
      element('p', 'onboarding-hint', 'OpenCode free models cannot be routed. Keep them as a direct opencode-free provider for the OpenCode adapter.'),
      renderProviderRows({ showPrivate: true, allowDelete: true, excludeKinds: ['opencode-free', 'pi'] }),
      addProviderForm({ excludeKinds: ['opencode-free', 'pi'], title: 'Add an upstream provider' }),
    );
    if (!state!.providers.some(provider => !['router', 'opencode-free', 'pi'].includes(provider.kind))) {
      panel.append(element('p', 'onboarding-note', 'Add at least one upstream provider before models can be listed from the router.'));
    }
    return panel;
  }

  function externalPanel(): HTMLElement {
    const panel = element('section', 'onboarding-panel');
    const router = state!.providers.find(provider => provider.id === 'router');
    const baseUrl = element('input', 'onboarding-input') as HTMLInputElement;
    baseUrl.value = state!.config.router.external?.baseUrl ?? '';
    baseUrl.placeholder = 'https://router.example/v1';
    baseUrl.autocomplete = 'off';
    baseUrl.setAttribute('aria-label', 'External router base URL');
    const key = element('input', 'onboarding-input') as HTMLInputElement;
    key.type = 'password';
    key.autocomplete = 'off';
    key.spellcheck = false;
    key.placeholder = 'Optional for a loopback router';
    key.setAttribute('aria-label', 'External router key');
    const save = element('button', 'onboarding-primary', 'Save external router') as HTMLButtonElement;
    save.type = 'button';
    save.addEventListener('click', async () => {
      const value = baseUrl.value.trim();
      if (!/^https?:\/\//.test(value)) {
        notify('Enter an http or https router URL.', true);
        baseUrl.focus();
        return;
      }
      const provider: OnboardingProvider = {
        id: 'router',
        kind: 'router',
        label: 'External router',
        baseUrl: value,
        routerType: isLoopbackUrl(value) ? 'self-hosted' : 'hosted',
      };
      setBusy(true, 'Saving external router…');
      try {
        state = await api.addProvider(provider, { mode: 'external', external: { baseUrl: value } });
        if (key.value) state = await api.setProviderKey('router', key.value);
        key.value = '';
        mode = 'external';
        notify('External router saved.');
        render();
      } catch (error) {
        key.value = '';
        notify(error instanceof Error ? error.message : 'The external router could not be saved.', true);
      } finally {
        setBusy(false);
      }
    });
    panel.append(
      element('h3', '', 'External router'),
      element('p', '', 'Use one OpenAI-compatible endpoint you already run or subscribe to. Orbit starts nothing locally. A key is optional only for a loopback router you control.'),
      labelled('Base URL', baseUrl),
      labelled('API key', key),
      element('p', 'onboarding-hint', `Current key: ${router ? maskedKey(router) : 'not set'}`),
      save,
    );
    return panel;
  }

  function renderStepOne(): HTMLElement {
    const section = element('section', 'onboarding-step-panel');
    section.append(element('h2', '', 'Choose what to install'), element('p', '', 'Only core is required. Everything here can be changed later in Settings.'));
    const choices = element('fieldset', 'onboarding-fieldset');
    choices.append(element('legend', '', 'Components'));
    choices.append(toggleRow('core', 'Orbit core', 'Required: the local workspace and host server.', true, true, () => {}));
    for (const [key, title, detail] of COMPONENT_CHOICES) choices.append(toggleRow(key, title, detail, Boolean(state!.config.components[key]), false, () => {}));
    section.append(choices);

    const appsField = element('input', 'onboarding-input') as HTMLInputElement;
    appsField.value = (state!.config.components.apps ?? []).join(', ');
    appsField.placeholder = 'Optional app ids, comma separated';
    appsField.setAttribute('aria-label', 'Optional app ids');
    section.append(labelled('Extra app ids', appsField, 'Installed apps are still sandboxed; this only records the selection.'));

    const routerBox = element('fieldset', 'onboarding-fieldset onboarding-router-choice');
    routerBox.append(element('legend', '', 'Token router'));
    let routerEnabled = Boolean(state!.config.components.router && state!.config.router.enabled);
    let engine: RouterEngine = state!.config.router.engine;
    const engineOptions: Array<[string, string]> = [['bifrost', 'Bifrost (recommended)']];
    if (engine === 'litellm') engineOptions.push(['litellm', 'LiteLLM (advanced)']);
    const engineSelect = choiceField(engineOptions, engine, value => { engine = value as RouterEngine; }, 'Token router engine');
    engineSelect.disabled = !routerEnabled;
    const advanced = element('details', 'onboarding-advanced');
    advanced.append(element('summary', '', 'Advanced engine options'));
    advanced.append(element('p', 'onboarding-hint', 'LiteLLM has wider provider coverage but a larger image and slower startup. It is installed only when selected, by pinned image digest.'));
    const showLitellm = element('button', 'onboarding-secondary', 'Offer LiteLLM') as HTMLButtonElement;
    showLitellm.type = 'button';
    if (engine === 'litellm') showLitellm.disabled = true;
    showLitellm.addEventListener('click', () => {
      if (!Array.from(engineSelect.options).some(option => option.value === 'litellm')) {
        const option = element('option', '', 'LiteLLM (advanced)');
        option.value = 'litellm';
        engineSelect.append(option);
      }
      engineSelect.value = 'litellm';
      engine = 'litellm';
      showLitellm.disabled = true;
    });
    advanced.append(showLitellm);
    routerBox.append(
      toggleRow('router', 'Token router (optional, off)', 'Runs a local gateway so every agent uses one URL with its own budget. Not needed for OpenCode free models. Nothing router-related starts unless this is on.', routerEnabled, false, checked => {
        routerEnabled = checked;
        engineSelect.disabled = !checked;
      }),
      labelled('Engine', engineSelect),
      advanced,
    );
    section.append(routerBox);

    const opencode = element('section', 'onboarding-opencode');
    opencode.append(element('h3', '', 'OpenCode detection'), element('p', 'onboarding-hint', 'Detection is read-only. Installation shows the exact command and requires confirmation.'));
    const detectButton = element('button', 'onboarding-secondary', 'Check for OpenCode') as HTMLButtonElement;
    detectButton.type = 'button';
    const detected = element('p', 'onboarding-detected', 'Not checked yet.');
    detectButton.addEventListener('click', async () => {
      setBusy(true, 'Checking for OpenCode…');
      try {
        const info = await api.detectOpencode();
        detected.textContent = info.opencode.installed
          ? `OpenCode found${info.opencode.version ? ` (version ${info.opencode.version})` : ''}.`
          : 'OpenCode is not on PATH or in the usual install directories.';
        if (!info.opencode.installed) {
          const install = element('button', 'onboarding-secondary', `Install: ${info.install.command}`) as HTMLButtonElement;
          install.type = 'button';
          install.addEventListener('click', async () => {
            if (!window.confirm(`Run ${info.install.command}?`)) return;
            setBusy(true, 'Installing OpenCode…');
            try {
              const result = await api.installOpencode(true);
              notify(result.installed ? 'OpenCode install command completed.' : 'Install finished; check for OpenCode again.');
              detected.textContent = result.installed ? 'OpenCode installed.' : detected.textContent;
            } catch (error) {
              notify(error instanceof Error ? error.message : 'OpenCode could not be installed.', true);
            } finally {
              setBusy(false);
            }
          });
          detected.append(document.createElement('br'), install);
        }
        notify('');
      } catch (error) {
        notify(error instanceof Error ? error.message : 'OpenCode detection failed.', true);
      } finally {
        setBusy(false);
      }
    });
    opencode.append(detectButton, detected);
    section.append(opencode);

    commitStepOne = async () => {
      const components = { ...state!.config.components };
      for (const [, key] of COMPONENT_CHOICES) {
        const input = section.querySelector<HTMLInputElement>(`input[data-setting="${key}"]`);
        if (input) (components as any)[key] = input.checked;
      }
      components.core = true;
      components.router = routerEnabled;
      components.apps = appsField.value.split(',').map(value => value.trim()).filter(Boolean);
      const router = { enabled: routerEnabled, engine, ...(routerEnabled ? { mode: state!.config.router.mode } : {}) };
      state = await api.saveComponents(components, router);
      if (routerEnabled && !state.config.router.enabled) throw new Error('The router selection was not saved.');
      if (routerEnabled && mode === 'direct') mode = 'builtin';
      notify(routerEnabled ? 'Install choices saved with the token router on.' : 'Install choices saved. No router will run.');
    };
    return section;
  }

  function renderStepTwo(): HTMLElement {
    const section = element('section', 'onboarding-step-panel');
    section.append(element('h2', '', 'Providers and keys'), element('p', '', 'Choose one path. Keys are written server-side to 0600 files and never returned in full.'));
    const routerAvailable = Boolean(state!.config.router.enabled);
    if (!routerAvailable && mode !== 'direct') mode = 'direct';
    const radios = element('div', 'onboarding-mode-toggle');
    radios.setAttribute('role', 'radiogroup');
    radios.setAttribute('aria-label', 'Provider path');
    const builtInUnavailable = !routerAvailable;
    const modeChoices: Array<[ProviderMode, string, string, boolean]> = [
      ['direct', 'Direct providers', 'Configure each provider and key yourself. This is the default.', false],
      ['builtin', 'Built-in router', routerAvailable ? 'Use the local token router enabled in step 1.' : 'Turn on the token router in step 1 first.', builtInUnavailable],
      ['external', 'External router', 'One hosted or self-hosted OpenAI-compatible endpoint. Orbit runs nothing locally.', false],
    ];
    for (const [value, labelText, detail, disabled] of modeChoices) {
      const label = element('label', 'onboarding-mode-option');
      const input = element('input') as HTMLInputElement;
      input.type = 'radio';
      input.name = 'provider-mode';
      input.value = value;
      input.checked = mode === value;
      input.disabled = disabled;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        mode = value;
        if (value === 'external' && !state!.config.router.enabled) {
          setBusy(true, 'Enabling the external router path…');
          void api.saveComponents({ ...state!.config.components, router: true }, { enabled: true, mode: 'builtin', engine: state!.config.router.engine })
            .then(next => {
              state = next;
              notify('External router path selected. Enter its URL below.');
              render();
            })
            .catch(error => notify(error instanceof Error ? error.message : 'Could not enable the router path.', true))
            .finally(() => setBusy(false));
          return;
        }
        if (value === 'builtin' && state!.config.router.mode !== 'builtin') {
          setBusy(true, 'Switching to the built-in router…');
          void api.saveComponents(state!.config.components, { enabled: true, mode: 'builtin', engine: state!.config.router.engine })
            .then(next => { state = next; notify('Built-in router selected.'); render(); })
            .catch(error => notify(error instanceof Error ? error.message : 'Could not switch the router mode.', true))
            .finally(() => setBusy(false));
          return;
        }
        notify('');
        render();
      });
      const copy = element('span', 'onboarding-mode-copy');
      copy.append(element('strong', '', labelText), element('small', '', detail));
      label.append(input, copy);
      radios.append(label);
    }
    section.append(radios);

    if (mode === 'builtin' && routerAvailable) section.append(builtinPanel());
    else if (mode === 'external') section.append(externalPanel());
    else section.append(directPanel());
    return section;
  }

  function render(): void {
    if (!state) return;
    content.replaceChildren();
    if (step === 0) content.append(renderStepOne());
    else if (step === 1) content.append(renderStepTwo());
    else if (step === 2) content.append(renderRolesStep(context()));
    else content.append(renderReviewStep(context()));
    updateProgress();
    back.disabled = busy || step === 0;
    next.disabled = busy || applied;
    title.focus();
  }

  back.addEventListener('click', () => {
    if (busy || step === 0) return;
    step -= 1;
    notify('');
    render();
  });

  next.addEventListener('click', async () => {
    if (busy) return;
    if (step === progressItems.length - 1) {
      if (applied) return;
      setBusy(true, 'Applying setup choices…');
      try {
        const result = await api.apply();
        state = result;
        applied = true;
        notify(result.applied ? 'Choices applied. The setup agent will install the selected components.' : 'Choices recorded.');
        render();
      } catch (error) {
        notify(error instanceof Error ? error.message : 'The setup choices could not be applied.', true);
      } finally {
        setBusy(false);
        render();
      }
      return;
    }
    if (step === 0 && commitStepOne) {
      setBusy(true, 'Saving install choices…');
      try {
        await commitStepOne();
        step = 1;
        notify(status.textContent ?? '');
        render();
      } catch (error) {
        notify(error instanceof Error ? error.message : 'The install choices could not be saved.', true);
      } finally {
        setBusy(false);
        render();
      }
      return;
    }
    step += 1;
    notify('');
    render();
  });

  next.disabled = true;
  root.append(wizard);
  void refresh();
  return {
    element: wizard,
    refresh,
    close() { wizard.remove(); },
  };
}
