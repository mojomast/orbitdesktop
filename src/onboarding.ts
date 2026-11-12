import { el, button } from './dom';
import './onboarding.css';
import {
  defaultSetupMode,
  minimalComponents,
  providerOptions,
  readRoleDraft,
  roleRows,
  validateRoles,
  renderRolesStep as renderRolesStepView,
  type ProviderLike,
  type RoleChoice,
  type RolesStepContextLike,
} from './onboarding-roles';
import { renderReviewStep as renderReviewStepView } from './onboarding-review';
import { STEP, STEP_LABELS, nextStep, previousStep } from './onboarding-steps';
import { createGithubApi, renderGithubSection, renderReposSection, type GithubApi, type ReposSectionHandle } from './onboarding-github';

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
  upstreams?: Array<{ providerId: string; weight?: number; models?: string[] }>;
  fallbacks?: Array<{ model: string; then: string[] }>;
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
  mode?: 'minimal' | 'custom';
  defaultModel?: OnboardingRoleChoice | null;
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
  getRoles(): Promise<OnboardingStateResponse & { mode?: 'minimal' | 'custom'; roles?: Record<string, OnboardingRoleChoice>; stored?: Record<string, OnboardingRoleChoice> }>;
  saveRoles(payload: Record<string, unknown>): Promise<OnboardingStateResponse & { mode?: 'minimal' | 'custom'; roles?: Record<string, OnboardingRoleChoice>; stored?: Record<string, OnboardingRoleChoice> }>;
  disableRouter(): Promise<OnboardingStateResponse>;
  rotateRouterKeys(role?: string): Promise<{ ok: boolean; rotated: string[] }>;
  apply(payload?: unknown): Promise<OnboardingStateResponse & { applied?: boolean }>;
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
    getRoles: () => request('GET', '/roles'),
    saveRoles: payload => request('PUT', '/roles', payload),
    disableRouter: () => request<OnboardingStateResponse>('PUT', '/components', { components: { router: false }, confirm: true }),
    rotateRouterKeys: role => request<{ ok: boolean; rotated: string[] }>('POST', '/router/rotate', role ? { role } : {}),
    apply: payload => request<OnboardingStateResponse & { applied?: boolean }>('POST', '/apply', payload ?? {}),
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

/** Step 3: editable provider/model and router-budget rows per role. */
export function renderRolesStep(context: OnboardingStepContext): HTMLElement {
  return renderRolesStepView(context as RolesStepContextLike);
}

/** Step 4: editable review of components, masked providers, roles and what runs. */
export function renderReviewStep(context: OnboardingStepContext): HTMLElement {
  return renderReviewStepView(context as never);
}

export interface OnboardingWizardHandle {
  element: HTMLElement;
  refresh(): Promise<void>;
  close(): void;
}

export function mountOnboarding(root: HTMLElement, api: OnboardingApi = createOnboardingApi(), github: GithubApi = createGithubApi()): OnboardingWizardHandle {
  const wizard = element('section', 'orbit-setup-wizard');
  wizard.setAttribute('aria-labelledby', 'orbit-setup-title');
  const top = element('div', 'onboarding-top');
  const title = element('h1', '', 'Set up Orbit');
  title.id = 'orbit-setup-title';
  title.tabIndex = -1;
  const progress = element('ol', 'onboarding-progress');
  const progressItems = [...STEP_LABELS].map((label, index) => {
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
  let setupPath: 'minimal' | 'custom' = defaultSetupMode();
  let pathInitialized = false;
  let minimalProvider = '';
  let minimalModel = '';
  let commitStepOne: (() => Promise<void>) | null = null;
  let commitStepTwo: (() => Promise<void>) | null = null;
  let commitStepThree: (() => Promise<void>) | null = null;
  let reposHandle: ReposSectionHandle | null = null;

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
      if (!pathInitialized) {
        const configured = (state.config.providers?.length ?? 0) > 0
          || Object.values(state.config.roles ?? {}).some(role => Boolean(role?.provider));
        setupPath = state.config.mode === 'minimal' ? 'minimal'
          : state.config.mode === 'custom' ? 'custom'
          : configured ? 'custom' : defaultSetupMode();
        pathInitialized = true;
      }
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

  function addProviderForm(options: { excludeKinds?: string[]; title?: string; asUpstream?: boolean } = {}): HTMLElement {
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
        const existingUpstreams = state!.config.router.upstreams ?? [];
        const routerPatch = options.asUpstream
          ? { upstreams: [...existingUpstreams.filter(entry => entry.providerId !== providerId), { providerId, weight: 1, models: ['*'] }] }
          : undefined;
        state = await api.addProvider(provider, routerPatch);
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
      addProviderForm({ excludeKinds: ['opencode-free', 'pi'], title: 'Add an upstream provider', asUpstream: true }),
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
    baseUrl.value = state!.config.router.external?.baseUrl || 'http://127.0.0.1:4000';
    baseUrl.placeholder = 'http://127.0.0.1:4000';
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
    section.append(element('h2', '', 'Choose what to install'), element('p', '', 'Pick Minimal install for the quickest path, or Custom to choose every component. Both can be changed later in Settings.'));

    const paths = element('fieldset', 'onboarding-fieldset onboarding-path-choice');
    paths.append(element('legend', '', 'Setup path'));
    const pathChoices: Array<['minimal' | 'custom', string, string, string]> = [
      ['minimal', 'Minimal install (recommended)', 'One provider and one model for every role. Core plus one first agent; nothing else runs.', 'minimal-path'],
      ['custom', 'Custom', 'Choose components, direct providers or the optional token router, and a model for each role.', 'custom-path'],
    ];
    for (const [value, heading, detail, id] of pathChoices) {
      const label = element('label', 'onboarding-mode-option onboarding-path-option');
      const input = element('input') as HTMLInputElement;
      input.type = 'radio';
      input.name = 'setup-path';
      input.value = value;
      input.id = id;
      input.checked = setupPath === value;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        setupPath = value;
        notify(value === 'minimal' ? 'Minimal install selected.' : 'Custom install selected.');
        render();
      });
      const copy = element('span', 'onboarding-mode-copy');
      copy.append(element('strong', '', heading), element('small', '', detail));
      label.append(input, copy);
      paths.append(label);
    }
    section.append(paths);

    let routerEnabled = Boolean(state!.config.components.router && state!.config.router.enabled);
    let engine: RouterEngine = state!.config.router.engine;
    let appsField: HTMLInputElement | null = null;
    let choices: HTMLFieldSetElement | null = null;
    let routerBox: HTMLFieldSetElement | null = null;

    if (setupPath === 'minimal') {
      const summary = element('dl', 'onboarding-review-list onboarding-minimal-summary');
      summary.append(
        element('dt', '', 'Components'), element('dd', '', 'Orbit core plus one first agent that matches your provider'),
        element('dt', '', 'Token router'), element('dd', '', 'Off. No router container or process runs.'),
        element('dt', '', 'Bundlebees, worker pairing, Colab, apps'), element('dd', '', 'Not installed'),
      );
      section.append(element('p', 'onboarding-note', 'You will choose the one provider and one model in the next step, then go straight to Review.'), summary);
    } else {
      choices = element('fieldset', 'onboarding-fieldset');
      choices.append(element('legend', '', 'Components'));
      choices.append(toggleRow('core', 'Orbit core', 'Required: the local workspace and host server.', true, true, () => {}));
      for (const [key, title, detail] of COMPONENT_CHOICES) choices.append(toggleRow(key, title, detail, Boolean(state!.config.components[key]), false, () => {}));
      section.append(choices);

      appsField = element('input', 'onboarding-input') as HTMLInputElement;
      appsField.value = (state!.config.components.apps ?? []).join(', ');
      appsField.placeholder = 'Optional app ids, comma separated';
      appsField.setAttribute('aria-label', 'Optional app ids');
      section.append(labelled('Extra app ids', appsField, 'Installed apps are still sandboxed; this only records the selection.'));

      routerBox = element('fieldset', 'onboarding-fieldset onboarding-router-choice');
      routerBox.append(element('legend', '', 'Token router'));
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
    }

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
      if (setupPath === 'minimal') {
        state = await api.saveComponents(minimalComponents(null) as never);
        notify('Minimal install selected. Only core is enabled until you choose a provider.');
        return;
      }
      const components = { ...state!.config.components };
      for (const [, key] of COMPONENT_CHOICES) {
        const input = section.querySelector<HTMLInputElement>(`input[data-setting="${key}"]`);
        if (input) (components as any)[key] = input.checked;
      }
      components.core = true;
      components.router = routerEnabled;
      components.apps = (appsField?.value ?? '').split(',').map(value => value.trim()).filter(Boolean);
      const router = { enabled: routerEnabled, engine, ...(routerEnabled ? { mode: state!.config.router.mode } : {}) };
      state = await api.saveComponents(components, router);
      if (routerEnabled && !state.config.router.enabled) throw new Error('The router selection was not saved.');
      if (state!.config.mode === 'minimal') {
        // Leaving Minimal materializes the effective roles, so nothing changes
        // until the person edits them in the next steps.
        state = await api.saveRoles({ mode: 'custom' }) as OnboardingStateResponse;
      }
      if (routerEnabled && mode === 'direct') mode = 'builtin';
      notify(routerEnabled ? 'Install choices saved with the token router on.' : 'Install choices saved. No router will run.');
    };
    return section;
  }

  function renderMinimalStepTwo(): HTMLElement {
    const section = element('section', 'onboarding-step-panel onboarding-minimal-step');
    section.append(
      element('h2', '', 'Providers and keys'),
      element('p', '', 'Minimal install: pick one provider and one model. That model is used for setup, chat, workers and summaries, and is editable later in Settings.'),
    );
    const available = providerOptions({ providers: state!.providers as ProviderLike[], router: state!.config.router });
    if (!available.length) section.append(element('p', 'onboarding-empty', 'No providers yet. Add the one you want to use below.'));
    if (!minimalProvider && available.length) minimalProvider = available[0].id;
    const providerSelect = choiceField(
      [['', 'Choose a provider'], ...available.map(provider => [provider.id, `${provider.label} (${providerKindLabel(provider.kind)})`] as [string, string])],
      minimalProvider,
      value => {
        minimalProvider = value;
        minimalModel = '';
        render();
      },
      'Minimal install provider',
    );
    section.append(labelled('Provider', providerSelect, 'Only this provider is used by every role in minimal mode.'));
    const selected = state!.providers.find(provider => provider.id === minimalProvider);

    if (selected) {
      const keyInput = element('input', 'onboarding-input') as HTMLInputElement;
      keyInput.type = 'password';
      keyInput.autocomplete = 'off';
      keyInput.spellcheck = false;
      keyInput.placeholder = selected.key?.set ? `Replace key (${maskedKey(selected)})` : 'Paste key if this provider needs one';
      keyInput.setAttribute('aria-label', `API key for ${selected.label}`);
      const saveKey = element('button', 'onboarding-secondary', 'Save key') as HTMLButtonElement;
      saveKey.type = 'button';
      saveKey.addEventListener('click', async () => {
        if (!keyInput.value) { notify('Enter a key before saving.', true); keyInput.focus(); return; }
        setBusy(true, 'Saving key…');
        try {
          state = await api.setProviderKey(selected.id, keyInput.value);
          keyInput.value = '';
          notify(`Key saved for ${selected.label}.`);
          render();
        } catch (error) {
          keyInput.value = '';
          notify(error instanceof Error ? error.message : 'The key could not be saved.', true);
        } finally { setBusy(false); }
      });
      const keyRow = element('div', 'onboarding-provider-actions');
      keyRow.append(keyInput, saveKey);
      section.append(labelled('API key', keyRow, `Current key: ${maskedKey(selected)}. Keys are stored in 0600 files and never returned in full.`));

      const modelSelect = element('select', 'onboarding-select') as HTMLSelectElement;
      modelSelect.setAttribute('aria-label', 'Minimal install model');
      modelSelect.append(element('option', '', 'Loading models…'));
      const manual = element('input', 'onboarding-input onboarding-model-fallback') as HTMLInputElement;
      manual.type = 'text';
      manual.autocomplete = 'off';
      manual.placeholder = 'Model id (manual fallback)';
      manual.value = minimalModel;
      manual.setAttribute('aria-label', 'Model id');
      manual.addEventListener('input', () => { minimalModel = manual.value.trim(); });
      modelSelect.addEventListener('change', () => { minimalModel = modelSelect.value; manual.value = modelSelect.value; });
      section.append(labelled('Model', modelSelect, 'Models load from the provider at runtime. If the list is unavailable, type the model id.'), labelled('Or type a model id', manual));
      void api.listModels(selected.id).then(result => {
        const entries = result.models.map(model => [model.id, model.label && model.label !== model.id ? `${model.label} (${model.id})` : model.id] as [string, string]);
        if (!entries.length) {
          modelSelect.replaceChildren(element('option', '', 'No model list; type one below'));
          return;
        }
        modelSelect.replaceChildren(...entries.map(([value, text]) => {
          const option = element('option', '', text);
          option.value = value;
          return option;
        }));
        if (!minimalModel) minimalModel = (result.default && entries.some(([value]) => value === result.default)) ? result.default : entries[0][0];
        modelSelect.value = minimalModel;
        manual.value = minimalModel;
      }).catch(() => {
        modelSelect.replaceChildren(element('option', '', 'Model list unavailable; type one below'));
        notify('The model list was unavailable. Type a model id instead.', true);
      });
    }

    section.append(addProviderForm({ title: 'Add the provider you want to use' }));
    section.append(element('p', 'onboarding-hint', 'Next goes straight to Review. Only core and one first agent are installed; the built-in router stays off.'));

    commitStepTwo = async () => {
      if (!minimalProvider) throw new Error('Choose the one provider to use.');
      if (!minimalModel.trim()) throw new Error('Choose or type the one model to use.');
      const provider = state!.providers.find(entry => entry.id === minimalProvider);
      if (!provider) throw new Error('The chosen provider is no longer available.');
      const components = minimalComponents(provider.kind);
      if (provider.kind === 'router') {
        state = await api.saveComponents(components as never, {
          enabled: true,
          mode: 'external',
          engine: state!.config.router.engine,
          external: { baseUrl: provider.baseUrl ?? state!.config.router.external?.baseUrl ?? '' },
        });
      } else {
        state = await api.saveComponents(components as never, { enabled: false });
      }
      const clearRoles = Object.fromEntries(
        [...new Set(['setup', 'chat', 'workers', 'summarize', ...Object.keys(state!.config.roles ?? {})])]
          .map(role => [role, { provider: '', model: '' }]),
      );
      const saved = await api.saveRoles({ mode: 'minimal', defaultModel: { provider: minimalProvider, model: minimalModel.trim() }, roles: clearRoles });
      state = saved as OnboardingStateResponse;
      notify('Minimal install ready to review. No router will run.');
    };
    return section;
  }

  function renderStepTwo(): HTMLElement {
    if (setupPath === 'minimal') return renderMinimalStepTwo();
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

  function optionalStepsCard(): HTMLElement {
    const card = element('aside', 'onboarding-optional-card');
    card.append(element('strong', '', 'Optional: Connect GitHub · Repos to watch'),
      element('p', 'onboarding-hint', 'Both are optional and can be changed later in Settings.'));
    const row = element('div', 'onboarding-optional-actions');
    for (const [label, target] of [['Connect GitHub', STEP.github], ['Choose repos to watch', STEP.repos]] as const) {
      const open = element('button', 'onboarding-secondary', label) as HTMLButtonElement;
      open.type = 'button';
      open.addEventListener('click', () => { if (busy || applied) return; step = target; notify(''); render(); });
      row.append(open);
    }
    card.append(row);
    return card;
  }

  function render(): void {
    if (!state) return;
    content.replaceChildren();
    commitStepThree = null;
    reposHandle = null;
    if (step === 0) content.append(renderStepOne());
    else if (step === 1) content.append(renderStepTwo());
    else if (step === 2) {
      const rolesElement = renderRolesStep(context());
      content.append(rolesElement);
      commitStepThree = async () => {
        const draft = readRoleDraft(rolesElement);
        const validation = validateRoles(state!.config as never, draft);
        if (!validation.ok) throw new Error(validation.errors[0] ?? 'Choose a provider and model for each required role.');
        const saved = await api.saveRoles({ roles: validation.roles });
        state = saved as OnboardingStateResponse;
      };
    } else if (step === STEP.github) {
      content.append(renderGithubSection({ api: github, notify }));
      const skip = element('button', 'onboarding-secondary orbit-github-skip', 'Skip GitHub for now') as HTMLButtonElement;
      skip.type = 'button';
      skip.addEventListener('click', () => { if (busy) return; step = STEP.repos; notify('GitHub skipped. You can connect it later in Settings.'); render(); });
      content.append(skip);
    } else if (step === STEP.repos) {
      reposHandle = renderReposSection({ api: github, notify });
      content.append(reposHandle.element);
    } else {
      content.append(renderReviewStep(context()));
      content.append(optionalStepsCard());
    }
    updateProgress();
    back.disabled = busy || step === 0;
    next.disabled = busy || applied;
    title.focus();
  }

  back.addEventListener('click', () => {
    if (busy || step === 0) return;
    step = previousStep(step, setupPath);
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
    if (step === 1) {
      if (setupPath === 'minimal') {
        if (!commitStepTwo) { step = 1; render(); return; }
        setBusy(true, 'Saving the provider and model…');
        try {
          await commitStepTwo();
          step = nextStep(STEP.providers, 'minimal');
          notify('Provider, key and model saved. Review and apply.');
          render();
        } catch (error) {
          notify(error instanceof Error ? error.message : 'The minimal install choices could not be saved.', true);
        } finally {
          setBusy(false);
          render();
        }
        return;
      }
      step = STEP.models;
      notify('');
      render();
      return;
    }
    if (step === STEP.models) {
      if (!commitStepThree) { step = STEP.github; render(); return; }
      setBusy(true, 'Saving role mapping…');
      try {
        await commitStepThree();
        step = STEP.github;
        notify('Role mapping saved. Connect GitHub, or skip it.');
        render();
      } catch (error) {
        notify(error instanceof Error ? error.message : 'The role mapping could not be saved.', true);
      } finally {
        setBusy(false);
        render();
      }
      return;
    }
    if (step === STEP.repos && reposHandle) {
      setBusy(true, 'Saving repositories to watch…');
      try {
        const saved = await reposHandle.save();
        step = STEP.review;
        setBusy(false);
        notify(saved.length ? `Watching ${saved.length} ${saved.length === 1 ? 'repository' : 'repositories'}. Review and apply.` : 'No repositories watched. Review and apply.');
        render();
      } catch (error) {
        // Keep the typed list on screen so it can be corrected.
        setBusy(false);
        notify(error instanceof Error ? error.message : 'The repositories could not be saved.', true);
      }
      return;
    }
    step = nextStep(step, setupPath);
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
