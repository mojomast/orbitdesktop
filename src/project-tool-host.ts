// Host-rendered Project Workbench tools.
//
// Trusted parent-realm surface for one durable project-tool instance. The
// reserved URL `orbit://project-tool/<instance-uuid>` carries no project,
// credential or role content: the server resolves the UUID against the actual
// pane and workspace, and this module never trusts the URL as authority.
//
// Private notebook/check bytes are read only through the owner API
// `/api/workbench/tools`. Nothing here writes data into the layout, workspace
// events, `sessionStorage` or an embedded frame. Drafts are memory only so they
// survive connected DOM moves and save conflicts but not a page reload; saved
// data survives reload because it lives on the server.
//
// A "release" is a renderer/data-contract pin, never notebook content. Repinning
// or undoing a layout checkpoint therefore can never revert notebook text.
import { button, el } from './dom';
import { workspaceId } from './workspace-sync';
import './project-tools.css';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Reserved pane URL prefix. The suffix is an opaque instance UUID. */
export const PROJECT_TOOL_URL_PREFIX = 'orbit://project-tool/';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function projectToolUrl(instanceId: string): string {
  return `${PROJECT_TOOL_URL_PREFIX}${instanceId}`;
}

/** Strict parse. Returns null for any non-project-tool or malformed URL. */
export function projectToolId(url: string): string | null {
  if (typeof url !== 'string' || !url.startsWith(PROJECT_TOOL_URL_PREFIX)) return null;
  const id = url.slice(PROJECT_TOOL_URL_PREFIX.length);
  return UUID_PATTERN.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Contract types (frozen v1)
// ---------------------------------------------------------------------------

export type ProjectToolKind = 'notebook' | 'evidence_checks';
export type ProjectToolRenderVersion = 1 | 2;

export const PROJECT_TOOL_KIND_LABELS: Record<ProjectToolKind, string> = {
  notebook: 'Notebook',
  evidence_checks: 'Checks / review card',
};

export interface ProjectToolConfig {
  font_size: number;
  show_counts: boolean;
}

export interface ProjectToolInstance {
  version: 1;
  id: string;
  workspace_id: string;
  project_id: string;
  definition_id: string;
  release_id: string;
  kind: ProjectToolKind;
  title: string;
  config: Partial<ProjectToolConfig>;
  enabled: boolean;
  revoked: boolean;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface ProjectToolRelease {
  id: string;
  definition_id: string;
  release: '1' | '2';
  host_digest: string;
  data_schema_version: 1;
  status: 'available';
  render_version: ProjectToolRenderVersion;
  kind?: ProjectToolKind;
  [key: string]: unknown;
}

export interface ProjectToolDefinition {
  id: string;
  kind: ProjectToolKind;
  title: string;
  releases?: ProjectToolRelease[];
  render_versions?: ProjectToolRenderVersion[];
  [key: string]: unknown;
}

export interface ProjectToolLimits {
  [key: string]: unknown;
}

export interface ProjectToolMetadata {
  definitions: ProjectToolDefinition[];
  releases: ProjectToolRelease[];
  instances: ProjectToolInstance[];
  legacy_plugins: unknown[];
  limits: ProjectToolLimits;
}

export interface ProjectToolCheckReview {
  decision?: string;
  review_identity?: string | null;
  created_at?: number | null;
}

export interface ProjectToolCheckRecord {
  evidence_id?: string;
  job_id?: string | null;
  task_id?: string | null;
  candidate_id?: string | null;
  definition_id?: string | null;
  definition_digest?: string | null;
  verdict?: string;
  exit_code?: number | null;
  timed_out?: boolean;
  process_survival_unknown?: boolean;
  candidate_hash_before?: string | null;
  candidate_hash_after?: string | null;
  project_generation?: number | null;
  created_at?: number | null;
  review?: ProjectToolCheckReview | null;
}

export interface ProjectToolChecks {
  version?: number;
  recorded_count?: number;
  truncated?: boolean;
  recorded?: ProjectToolCheckRecord[];
  message?: string;
  [key: string]: unknown;
}

export interface ProjectToolResolveResult {
  instance: ProjectToolInstance;
  release: ProjectToolRelease;
  policy_generation: number;
  checks?: ProjectToolChecks;
}

export interface ProjectToolDataReadResult {
  data: { text: string };
  /** Data revision used as the CAS base for the next save. */
  revision: number;
  data_schema_version: 1;
  /** Instance metadata revision used as the CAS base for configure/repin. */
  instance_revision: number;
  policy_generation: number;
}

export interface ProjectToolDataSaveResult {
  revision: number;
  instance_id: string;
  data_schema_version: 1;
}

export interface ProjectToolPreviewResult {
  preview_id: string;
  preview_digest: string;
  expires_at: number;
  diff: unknown[];
  rendered: false;
  tested: false;
}

// ---------------------------------------------------------------------------
// Owner request helper
// ---------------------------------------------------------------------------

/** A sanitized owner-API error. `unknownOutcome` means a mutation may have applied. */
export class ProjectToolRequestError extends Error {
  readonly code: string;
  readonly reason: string | null;
  readonly unknownOutcome: boolean;
  constructor(code: string, unknownOutcome = false, reason: string | null = null) {
    super(code);
    this.name = 'ProjectToolRequestError';
    this.code = code;
    this.reason = reason;
    this.unknownOutcome = unknownOutcome;
  }
}

export interface ProjectToolRequestOptions {
  token: string;
  workspaceId?: string;
  signal?: AbortSignal;
}

/**
 * POST one owner request to `/api/workbench/tools`.
 *
 * Mutations must already carry `op_id` and `intent` from the caller so an
 * unknown outcome can be retried with the exact same key and payload. No retry
 * happens here.
 */
export async function projectToolsRequest<T = Record<string, unknown>>(
  body: Record<string, unknown>,
  options: ProjectToolRequestOptions,
): Promise<T> {
  if (!options.token) throw new ProjectToolRequestError('permission_denied');
  let response: Response;
  try {
    response = await fetch('/api/workbench/tools', {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: options.workspaceId ?? workspaceId, ...body }),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // The request may or may not have reached the server.
    throw new ProjectToolRequestError('outcome_unknown', true);
  }
  let value: { ok?: boolean; code?: string; reason?: string } & Record<string, unknown>;
  try {
    value = (await response.json()) as typeof value;
  } catch {
    throw new ProjectToolRequestError(response.ok ? 'unavailable' : 'outcome_unknown', !response.ok);
  }
  if (!response.ok || value.ok !== true) {
    throw new ProjectToolRequestError(
      typeof value.code === 'string' ? value.code : 'unavailable',
      false,
      typeof value.reason === 'string' ? value.reason : null,
    );
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Host mount
// ---------------------------------------------------------------------------

export const PROJECT_TOOL_CHANGED_EVENT = 'orbit-project-tool-changed';
export const PROJECT_TOOL_OPEN_EVENT = 'orbit-project-open-tool';

const POLL_INTERVAL_MS = 1000;
const MAX_DRAFT_BYTES = 200_000;
const MAX_TITLE = 200;
const MAX_STATUS = 400;

// Drafts are memory only. Keyed by workspace + instance so a workspace switch
// cannot surface another workspace's unsaved bytes, and so a connected DOM move
// (which disposes and remounts the pane view) restores the draft.
const drafts = new Map<string, string>();

const asText = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, MAX_STATUS) : value === undefined || value === null ? '' : String(value).slice(0, MAX_STATUS);

const asCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

interface BaseView {
  element: HTMLElement;
  applyConfig(config: Partial<ProjectToolConfig>): void;
  dispose(): void;
}

interface NotebookView extends BaseView {
  kind: 'notebook';
  applyText(text: string): void;
  setStatus(state: string, message: string): void;
  setDirty(dirty: boolean): void;
  setConflict(visible: boolean): void;
  setPending(message: string | null, onRetry?: (() => void) | null): void;
}

interface ChecksView extends BaseView {
  kind: 'evidence_checks';
  applyChecks(checks: ProjectToolChecks | null, status: string): void;
}

type ToolView = NotebookView | ChecksView;

function createNotebookView(options: {
  title: string;
  release: ProjectToolRelease;
  getDraft: () => string;
  getDirty: () => boolean;
  onInput: (value: string) => void;
  onSave: () => void;
  onRetry: () => void;
  onReload: () => void;
}): NotebookView {
  const renderVersion = options.release.render_version;
  const root = el('section', 'project-tool-notebook');
  const head = el('header', 'project-tool-head');
  const heading = el('h3', 'project-tool-title', options.title.slice(0, MAX_TITLE));
  const badge = el('span', 'project-tool-badge', `notebook · renderer v${renderVersion}`);
  head.append(heading, badge);

  const bar = el('div', 'project-tool-actions');
  const save = button('Save notebook', 'Save the notebook through the owner API', () => options.onSave(), 'project-tool-save');
  const reload = button('Reload saved note', 'Replace the editor with the latest saved note; unsaved draft is discarded', () => options.onReload(), 'project-tool-reload');
  const count = el('span', 'project-tool-count', '');
  const status = el('p', 'project-tool-status', 'Loading saved note…');
  status.setAttribute('role', 'status');
  bar.append(save, reload, count);
  save.disabled = true;

  const conflict = el('div', 'project-tool-conflict');
  conflict.setAttribute('role', 'alert');
  conflict.hidden = true;

  const pending = el('div', 'project-tool-pending');
  pending.setAttribute('role', 'alert');
  pending.hidden = true;
  const retry = button('Retry the exact save', 'Resend the retained operation with the same key and payload', () => options.onRetry(), 'project-tool-retry');
  retry.hidden = true;
  const pendingText = el('p', 'project-tool-pending-text', '');
  pending.append(pendingText, retry);

  const editor = el('textarea', 'project-tool-editor');
  editor.setAttribute('aria-label', 'Notebook text');
  editor.spellcheck = false;
  editor.value = options.getDraft();

  let dirty = options.getDirty();
  let pendingState = false;
  let showCounts = false;

  const updateCount = () => {
    count.textContent = showCounts ? `${editor.value.length} characters` : '';
    count.hidden = !showCounts;
  };
  const updateSave = () => {
    save.disabled = !dirty || pendingState;
  };
  editor.addEventListener('input', () => {
    const value = editor.value.slice(0, MAX_DRAFT_BYTES);
    if (value !== editor.value) editor.value = value;
    dirty = true;
    updateSave();
    updateCount();
    options.onInput(value);
  });

  updateCount();
  updateSave();

  return {
    kind: 'notebook',
    element: (() => {
      root.append(head, bar, status, pending, conflict, editor);
      return root;
    })(),
    applyText(text: string) {
      if (options.getDirty()) {
        // Keep the current draft, including an intentionally empty unsaved draft;
        // only an explicit reload clears dirtiness.
        editor.value = options.getDraft();
        dirty = true;
        status.textContent = 'Local draft retained (unsaved); the saved copy is not shown over it.';
      } else {
        editor.value = text;
        dirty = false;
        status.textContent = 'Saved note loaded.';
      }
      updateSave();
      updateCount();
    },
    applyConfig(config: Partial<ProjectToolConfig>) {
      const size = asCount(config.font_size);
      if (size !== null && size >= 12 && size <= 28) root.style.fontSize = `${size}px`;
      // The count companion exists only on the v2 trusted renderer descriptor.
      showCounts = renderVersion >= 2 && config.show_counts === true;
      updateCount();
    },
    setStatus(state: string, message: string) {
      status.textContent = asText(message);
      status.dataset.state = state;
    },
    setDirty(next: boolean) {
      dirty = next;
      updateSave();
    },
    setConflict(visible: boolean) {
      conflict.hidden = !visible;
      if (visible) {
        conflict.replaceChildren(
          el('strong', '', 'Save conflict'),
          el('p', '', 'The stored note changed since this draft was based on it. Your draft is retained here; reload only if you mean to discard it.'),
        );
      }
    },
    setPending(message: string | null, onRetry: (() => void) | null = null) {
      pendingState = message !== null;
      pending.hidden = message === null;
      if (message !== null) pendingText.textContent = message;
      retry.hidden = onRetry === null;
      updateSave();
    },
    dispose() {
      root.remove();
    },
  };
}

function createChecksView(options: { title: string; release: ProjectToolRelease }): ChecksView {
  const root = el('section', 'project-tool-checks');
  const head = el('header', 'project-tool-head');
  head.append(
    el('h3', 'project-tool-title', options.title.slice(0, MAX_TITLE)),
    el('span', 'project-tool-badge', `checks · renderer v${options.release.render_version}`),
  );
  const status = el('p', 'project-tool-status', 'Loading sanitized check facts…');
  status.setAttribute('role', 'status');
  const summary = el('p', 'project-tool-check-summary', '');
  const list = el('div', 'project-tool-check-list');
  root.append(head, status, summary, list);
  let compact = options.release.render_version >= 2;

  return {
    kind: 'evidence_checks',
    element: root,
    applyConfig(config: Partial<ProjectToolConfig>) {
      compact = options.release.render_version >= 2 && config.show_counts !== false;
      list.classList.toggle('is-compact', compact);
    },
    applyChecks(checks: ProjectToolChecks | null, state: string) {
      list.replaceChildren();
      status.textContent = asText(state);
      const recorded = Array.isArray(checks?.recorded) ? checks!.recorded! : [];
      const total = asCount(checks?.recorded_count) ?? recorded.length;
      summary.textContent = asText(checks?.message) || (total ? `${total} recorded evidence record${total === 1 ? '' : 's'}` : 'No recorded evidence; absence of records is never a pass.');
      if (!recorded.length) {
        list.append(el('p', 'project-tool-empty', 'No recorded evidence exists for this project. This is not a pass.'));
        return;
      }
      if (checks?.truncated) list.append(el('p', 'project-tool-empty', `Showing the ${recorded.length} most recent of ${total} recorded records.`));
      for (const item of recorded) {
        const row = el('article', 'project-tool-check');
        const verdict = asText(item?.verdict) || 'inconclusive';
        const label = asText(item?.definition_id) || 'check';
        row.append(el('strong', 'project-tool-verdict', verdict.toUpperCase()));
        row.append(el('span', 'project-tool-check-label', label));
        if (item?.review?.decision) row.append(el('span', 'project-tool-check-review', `review: ${asText(item.review.decision)}`));
        const details = el('details', 'project-tool-check-details');
        details.append(
          el('summary', '', 'Recorded evidence identity'),
          el('p', '', `Evidence ${asText(item?.evidence_id)}`),
          el('p', '', `Job ${asText(item?.job_id)}`),
          el('p', '', `Exit code ${item?.exit_code === null || item?.exit_code === undefined ? 'n/a' : String(item.exit_code)}${item?.timed_out ? ' · timed out' : ''}${item?.process_survival_unknown ? ' · process survival unknown' : ''}`),
          el('p', '', `Candidate ${asText(item?.candidate_id)}`),
        );
        if (item?.review?.review_identity) details.append(el('p', '', `Review identity ${asText(item.review.review_identity)}`));
        row.append(details);
        list.append(row);
      }
    },
    dispose() {
      root.remove();
    },
  };
}

/**
 * Mount the host-rendered surface for one project-tool instance into a pane body.
 *
 * @param instanceId parsed by the caller from the pane's current URL, so the
 *   server-side bind lookup is checked against the expected URL, not a guess.
 */
export function mountProjectToolHost(
  body: HTMLElement,
  paneId: string,
  getToken: () => string,
  instanceId?: string,
): () => void {
  const panel = el('section', 'project-tool-host');
  panel.dataset.paneId = paneId;
  body.replaceChildren(panel);

  const expectedId = instanceId && UUID_PATTERN.test(instanceId) ? instanceId : null;

  let disposed = false;
  let epoch = 0; // bumped on teardown/token change/tool change; fences delayed renders
  let gateGen = 0; // bumped whenever the authorization gate changes; fences delayed reads
  let resolveSeq = 0; // last resolve wins; stale resolve responses cannot overwrite a new gate
  let view: ToolView | null = null;
  let viewSignature = '';
  let lastToken: string | null = null;
  let timer: number | undefined;
  const controllers = new Set<AbortController>();

  const state = {
    instance: null as ProjectToolInstance | null,
    release: null as ProjectToolRelease | null,
    checks: null as ProjectToolChecks | null,
    dataRevision: 0,
    instanceRevision: 0,
    policyGeneration: 0,
    gateOpen: false,
    draft: expectedId ? drafts.get(`${workspaceId}:${expectedId}`) ?? '' : '',
    // A draft present in the module map is by definition unsaved (saved drafts are
    // deleted), so an intentionally empty unsaved draft is still dirty.
    dirty: expectedId ? drafts.has(`${workspaceId}:${expectedId}`) : false,
    serverText: null as string | null,
    pendingSave: null as { op_id: string; intent: string; text: string; body: Record<string, unknown> } | null,
  };

  function request<T>(requestBody: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    controllers.add(controller);
    return projectToolsRequest<T>(requestBody, {
      token: getToken(),
      workspaceId,
      signal: controller.signal,
    }).finally(() => {
      controllers.delete(controller);
    });
  }

  function disposeView() {
    view?.dispose();
    view = null;
    viewSignature = '';
    // `state.checks` is the current resolve projection and is applied on every
    // poll, so it is preserved across a view rebuild; only clearPrivate clears it.
    state.serverText = null;
  }

  function clearPrivate(reason: string, gate: 'unbound' | 'disabled' | 'revoked' | 'error' | 'locked') {
    if (disposed) return;
    epoch++;
    gateGen++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    disposeView();
    state.gateOpen = false;
    state.instance = null;
    state.release = null;
    state.checks = null;
    // `state.draft` is local, not server-derived, and is intentionally retained.
    panel.replaceChildren(el('p', `project-tool-gate is-${gate}`, asText(reason)));
  }

  function gateMessage(): void {
    const instance = state.instance;
    if (!instance) return;
    if (instance.revoked) {
      clearPrivate('This project tool was revoked. Previously delivered text cannot be recalled, but no further private data is read here.', 'revoked');
    } else if (!instance.enabled) {
      clearPrivate('This project tool is disabled (or a recovery hold is active). Private data is not shown; the owner can still configure or repin it.', 'disabled');
    }
  }

  function signature(instance: ProjectToolInstance, release: ProjectToolRelease): string {
    return [
      instance.id,
      instance.release_id,
      release.render_version,
      release.data_schema_version,
      instance.kind,
      instance.title,
      instance.config.font_size ?? null,
      instance.config.show_counts ?? null,
    ].join('\u0000');
  }

  function buildView(instance: ProjectToolInstance, release: ProjectToolRelease): ToolView {
    if (instance.kind === 'evidence_checks') {
      const checksView = createChecksView({ title: instance.title, release });
      checksView.applyConfig(instance.config);
      return checksView;
    }
    const notebook = createNotebookView({
      title: instance.title,
      release,
      getDraft: () => state.draft,
      getDirty: () => state.dirty,
      onInput: (value: string) => {
        state.draft = value;
        state.dirty = true;
        if (expectedId) drafts.set(`${workspaceId}:${expectedId}`, value);
      },
      onSave: () => void save(),
      onRetry: () => void retrySave(),
      onReload: () => void reloadLatest(),
    });
    notebook.applyConfig(instance.config);
    return notebook;
  }

  function checksStatus(): string {
    return state.checks ? 'Sanitized recorded check facts.' : 'No sanitized check facts are available.';
  }

  function renderResolved(): void {
    const instance = state.instance;
    const release = state.release;
    if (!instance || !release || !expectedId) return;
    const next = signature(instance, release);
    if (view && next === viewSignature) {
      // A same-signature authorization poll must never overwrite notebook editor
      // status, but check projections are re-applied so new/superseded recorded
      // facts appear without a manual refresh.
      if (view.kind === 'evidence_checks') view.applyChecks(state.checks, checksStatus());
      return;
    }
    disposeView();
    view = buildView(instance, release);
    viewSignature = next;
    panel.replaceChildren(view.element);
    if (view.kind === 'evidence_checks') {
      view.applyChecks(state.checks, checksStatus());
      return;
    }
    view.applyText('');
    view.setStatus('loading', 'Reading saved note from the owner API…');
    void loadPrivate();
  }

  function applyResolve(result: ProjectToolResolveResult): void {
    const instance = result.instance;
    const release = result.release;
    if (!instance || typeof instance.id !== 'string') {
      clearPrivate('The tool binding response was malformed.', 'error');
      return;
    }
    if (!expectedId || instance.id !== expectedId || instance.workspace_id !== workspaceId) {
      clearPrivate('This pane is not the bound surface for the resolved project tool.', 'unbound');
      return;
    }
    state.instance = instance;
    state.release = release;
    state.checks = result.checks ?? null;
    state.policyGeneration = asCount(result.policy_generation) ?? state.policyGeneration;
    state.instanceRevision = asCount(instance.revision) ?? state.instanceRevision;
    if (instance.revoked || !instance.enabled) {
      gateGen++;
      gateMessage();
      return;
    }
    state.gateOpen = true;
    renderResolved();
  }

  async function resolve(): Promise<void> {
    if (disposed || !expectedId) return;
    const token = getToken();
    if (!token) {
      lastToken = token;
      clearPrivate('Unlock this workspace to read the bound project tool.', 'locked');
      return;
    }
    if (lastToken !== null && lastToken !== token) {
      // Owner identity changed: drop every server-derived byte immediately.
      lastToken = token;
      clearPrivate('Owner session changed; reconnecting to the bound project tool.', 'locked');
    } else {
      lastToken = token;
    }
    const seq = ++resolveSeq;
    const controller = new AbortController();
    controllers.add(controller);
    const epochAtStart = epoch;
    try {
      const result = await projectToolsRequest<ProjectToolResolveResult>(
        { action: 'resolve', pane_id: paneId, instance_id: expectedId },
        { token, workspaceId, signal: controller.signal },
      );
      if (disposed || seq !== resolveSeq || epochAtStart !== epoch || token !== getToken()) return;
      applyResolve(result);
    } catch (error) {
      if (disposed || seq !== resolveSeq) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const code = error instanceof ProjectToolRequestError ? error.code : 'unavailable';
      const reason = error instanceof ProjectToolRequestError ? error.reason : null;
      if (code === 'outcome_unknown') {
        clearPrivate('Project tool authorization outcome is unknown; no private data is shown.', 'error');
      } else if (code === 'revoked' || code === 'permission_denied') {
        clearPrivate('This project tool is not authorized for this pane (revoked or unbound). No private data is shown.', 'revoked');
      } else if (code === 'unavailable') {
        clearPrivate('This project tool is disabled. Private data is not shown here; the owner can still configure or repin it.', 'disabled');
      } else if (code === 'conflict' || code === 'recovery_hold' || code === 'RECOVERY_HOLD' || reason === 'recovery_hold') {
        clearPrivate('Project tool reads are blocked by the current recovery policy. No private data is shown.', 'disabled');
      } else if (code === 'stale_resource') {
        clearPrivate('The project tool binding moved. Reopen it from the Project Workbench; no private data is shown.', 'unbound');
      } else {
        clearPrivate(`Project tool authorization is unavailable (${asText(code)}).`, 'error');
      }
    } finally {
      controllers.delete(controller);
    }
  }

  async function loadPrivate(): Promise<void> {
    const instance = state.instance;
    if (disposed || !instance || !expectedId || !state.gateOpen) return;
    // evidence_checks has no private data body: its facts arrive in `resolve`.
    if (instance.kind !== 'notebook') return;
    const token = getToken();
    if (!token) return;
    const gate = gateGen;
    const epochAtStart = epoch;
    try {
      const result = await request<ProjectToolDataReadResult>({
        action: 'data_read',
        project_id: instance.project_id,
        instance_id: expectedId,
        pane_id: paneId,
      });
      // Revalidate the gate after awaiting: a delayed read must never render
      // after a revoke/disable/hold or a newer resolve.
      if (disposed || gate !== gateGen || epochAtStart !== epoch || token !== getToken() || !state.gateOpen) return;
      state.dataRevision = asCount(result.revision) ?? state.dataRevision;
      state.instanceRevision = asCount(result.instance_revision) ?? state.instanceRevision;
      state.policyGeneration = asCount(result.policy_generation) ?? state.policyGeneration;
      state.serverText = typeof result.data?.text === 'string' ? result.data.text : '';
      if (view?.kind === 'notebook') view.applyText(state.serverText);
    } catch (error) {
      if (disposed) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const code = error instanceof ProjectToolRequestError ? error.code : 'unavailable';
      if (code === 'revoked' || code === 'permission_denied') {
        clearPrivate('This project tool is not authorized here. No private data is shown.', 'revoked');
        return;
      }
      if (code === 'unavailable' || code === 'conflict' || code === 'recovery_hold') {
        clearPrivate('This project tool is disabled or blocked by recovery policy. No private data is shown.', 'disabled');
        return;
      }
      if (view?.kind === 'notebook') view.setStatus('error', `Saved note unavailable (${asText(code)}). No newer content was substituted.`);
    }
  }

  interface SaveOperation {
    op_id: string;
    intent: string;
    text: string;
    body: Record<string, unknown>;
  }

  /** Submit one immutable save operation; never mutate the retained payload. */
  async function submit(operation: SaveOperation): Promise<void> {
    const instance = state.instance;
    if (disposed || !instance || !expectedId || !state.gateOpen) return;
    if (view?.kind !== 'notebook') return;
    const token = getToken();
    if (!token) return;
    const submitted = operation.text;
    view.setPending('Saving…', null);
    view.setConflict(false);
    const gate = gateGen;
    const epochAtStart = epoch;
    try {
      const result = await request<ProjectToolDataSaveResult>({ ...operation.body, op_id: operation.op_id, intent: operation.intent });
      if (disposed || gate !== gateGen || epochAtStart !== epoch || token !== getToken() || !state.gateOpen) return;
      state.pendingSave = null;
      state.dataRevision = asCount(result.revision) ?? state.dataRevision;
      state.serverText = submitted;
      if (state.draft === submitted) {
        state.dirty = false;
        drafts.delete(`${workspaceId}:${expectedId}`);
        if (view.kind === 'notebook') {
          view.setDirty(false);
          view.setPending(null);
          view.setStatus('ready', `Saved at data revision ${state.dataRevision}.`);
        }
      } else {
        // Newer edits arrived while the save was in flight: keep them dirty and
        // report only the revision the server actually recorded.
        state.dirty = true;
        drafts.set(`${workspaceId}:${expectedId}`, state.draft);
        if (view.kind === 'notebook') {
          view.setDirty(true);
          view.setPending(null);
          view.setStatus('dirty', `Saved submitted revision ${state.dataRevision}; newer local edits are retained (unsaved).`);
        }
      }
    } catch (error) {
      if (disposed) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof ProjectToolRequestError && (error.code === 'conflict' || error.code === 'stale_resource')) {
        state.pendingSave = null;
        state.dirty = true;
        drafts.set(`${workspaceId}:${expectedId}`, state.draft);
        if (view?.kind === 'notebook') {
          view.setPending(null);
          view.setDirty(true);
          view.setConflict(true);
          view.setStatus('conflict', 'Save conflict: the stored note changed. Your draft is retained; choose “Reload saved note” only to discard it.');
        }
        return;
      }
      if (error instanceof ProjectToolRequestError && error.unknownOutcome) {
        // Retain the immutable operation; the explicit retry button resends the
        // exact key and payload, and edits made meanwhile stay as a newer draft.
        state.pendingSave = operation;
        state.dirty = true;
        drafts.set(`${workspaceId}:${expectedId}`, state.draft);
        if (view?.kind === 'notebook') {
          view.setDirty(state.dirty);
          view.setPending('Save outcome unknown. This exact operation key and payload are retained; retry explicitly. No automatic retry will run.', () => void retrySave());
          view.setStatus('unknown', 'Save outcome unknown; the server may or may not have applied it.');
        }
        return;
      }
      state.pendingSave = null;
      state.dirty = true;
      drafts.set(`${workspaceId}:${expectedId}`, state.draft);
      const code = error instanceof ProjectToolRequestError ? error.code : 'unavailable';
      if (view?.kind === 'notebook') {
        view.setPending(null);
        view.setDirty(true);
        view.setStatus('error', `Save failed (${asText(code)}). The draft is retained.`);
      }
    }
  }

  async function save(): Promise<void> {
    const instance = state.instance;
    if (disposed || !instance || !expectedId || !state.gateOpen) return;
    if (view?.kind !== 'notebook') return;
    if (state.pendingSave) {
      // An unknown outcome must be resolved with the exact retained payload.
      view.setStatus('unknown', 'A previous save outcome is unknown; use “Retry the exact save”.');
      return;
    }
    await submit({
      op_id: crypto.randomUUID(),
      intent: 'Save project tool notebook revision',
      text: state.draft,
      body: {
        action: 'data_save',
        project_id: instance.project_id,
        instance_id: expectedId,
        pane_id: paneId,
        expected_revision: state.dataRevision,
        data: { text: state.draft },
      },
    });
  }

  async function retrySave(): Promise<void> {
    const operation = state.pendingSave;
    if (disposed || !operation || !expectedId) return;
    await submit(operation);
  }

  async function reloadLatest(): Promise<void> {
    const instance = state.instance;
    if (disposed || !instance || !expectedId || !state.gateOpen) return;
    if (view?.kind !== 'notebook') return;
    const token = getToken();
    if (!token) return;
    if (!window.confirm('Discard the current local draft and load the latest saved note?')) return;
    view.setPending('Loading latest saved note…');
    const gate = gateGen;
    const epochAtStart = epoch;
    try {
      const result = await request<ProjectToolDataReadResult>({
        action: 'data_read',
        project_id: instance.project_id,
        instance_id: expectedId,
        pane_id: paneId,
      });
      if (disposed || gate !== gateGen || epochAtStart !== epoch || token !== getToken() || !state.gateOpen) return;
      state.dataRevision = asCount(result.revision) ?? state.dataRevision;
      state.instanceRevision = asCount(result.instance_revision) ?? state.instanceRevision;
      state.serverText = typeof result.data?.text === 'string' ? result.data.text : '';
      state.draft = state.serverText;
      state.dirty = false;
      state.pendingSave = null;
      drafts.delete(`${workspaceId}:${expectedId}`);
      if (view?.kind === 'notebook') {
        view.applyText(state.serverText);
        view.setDirty(false);
        view.setConflict(false);
        view.setPending(null);
        view.setStatus('ready', `Reloaded latest saved note at data revision ${state.dataRevision}.`);
      }
    } catch (error) {
      if (disposed) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const code = error instanceof ProjectToolRequestError ? error.code : 'unavailable';
      if (code === 'revoked' || code === 'permission_denied') {
        clearPrivate('This project tool is not authorized here. No private data is shown.', 'revoked');
        return;
      }
      if (code === 'unavailable' || code === 'conflict' || code === 'recovery_hold') {
        clearPrivate('This project tool is disabled or blocked by recovery policy. No private data is shown.', 'disabled');
        return;
      }
      if (view?.kind === 'notebook') {
        view.setPending(null);
        view.setStatus('error', `Reload failed (${asText(code)}). The draft is retained.`);
      }
    }
  }

  function startPolling(): void {
    if (timer !== undefined) window.clearInterval(timer);
    timer = window.setInterval(() => void resolve(), POLL_INTERVAL_MS);
  }

  const onHostConnected = () => void resolve();
  const onToolChanged = (event: Event) => {
    const detail = (event as CustomEvent<{ workspace_id?: string; instance_id?: string }>).detail;
    if (!detail || detail.instance_id === undefined || detail.instance_id === expectedId) void resolve();
  };
  const onRecoveryPolicy = (event: Event) => {
    const detail = (event as CustomEvent<{ held?: boolean }>).detail;
    if (detail?.held) clearPrivate('A registered-plugin recovery hold is active. No private project tool data is shown.', 'disabled');
    else void resolve();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void resolve();
  };

  window.addEventListener('orbit-host-connected', onHostConnected);
  window.addEventListener(PROJECT_TOOL_CHANGED_EVENT, onToolChanged);
  window.addEventListener('orbit-recovery-policy', onRecoveryPolicy);
  document.addEventListener('visibilitychange', onVisibility);

  if (!expectedId) {
    clearPrivate('This pane URL does not identify a project tool instance.', 'unbound');
    return () => {
      disposed = true;
      epoch++;
      gateGen++;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      window.removeEventListener('orbit-host-connected', onHostConnected);
      window.removeEventListener(PROJECT_TOOL_CHANGED_EVENT, onToolChanged);
      window.removeEventListener('orbit-recovery-policy', onRecoveryPolicy);
      document.removeEventListener('visibilitychange', onVisibility);
      disposeView();
      panel.remove();
    };
  }

  void resolve();
  startPolling();

  return () => {
    disposed = true;
    epoch++;
    gateGen++;
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    window.removeEventListener('orbit-host-connected', onHostConnected);
    window.removeEventListener(PROJECT_TOOL_CHANGED_EVENT, onToolChanged);
    window.removeEventListener('orbit-recovery-policy', onRecoveryPolicy);
    document.removeEventListener('visibilitychange', onVisibility);
    // Clear private DOM but keep the memory draft for a connected remount.
    disposeView();
    panel.replaceChildren();
  };
}
