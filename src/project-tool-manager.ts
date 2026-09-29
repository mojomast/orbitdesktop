// Owner Project Workbench tool manager.
//
// Creates and manages durable trusted project-tool instances for one project.
// All mutations go through the owner API `/api/workbench/tools` with an
// explicit `op_id` + `intent`; an unknown outcome is retained for an explicit
// retry with the exact same key and payload and is never retried automatically.
//
// A release is a renderer/data-contract pin, never notebook content. Configure
// and repin stay available while an instance is disabled (but not when revoked),
// and neither can revert notebook text. Revocation is terminal and one-way.
import { button, el } from './dom';
import { ensureWorkspaceSynced, workspaceId } from './workspace-sync';
import { workspaceFetch } from './workspace-client';
import {
  PROJECT_TOOL_CHANGED_EVENT,
  PROJECT_TOOL_KIND_LABELS,
  PROJECT_TOOL_OPEN_EVENT,
  projectToolId,
  projectToolUrl,
  projectToolsRequest,
  ProjectToolRequestError,
  type ProjectToolDefinition,
  type ProjectToolInstance,
  type ProjectToolKind,
  type ProjectToolMetadata,
  type ProjectToolPreviewResult,
  type ProjectToolRelease,
} from './project-tool-host';
import './project-tools.css';

export interface ProjectToolManagerArgs {
  container: HTMLElement;
  getToken: () => string;
  workspace_id: string;
  project_id: string;
  onOpen?: (instance: ProjectToolInstance) => void;
}

export interface ProjectToolManager {
  dispose: () => void;
  refresh: () => Promise<void>;
}

const MUTATION_ERRORS = new Set(['conflict', 'stale_resource', 'revision_conflict', 'RECOVERY_POLICY_CHANGED', 'recovery_hold', 'RECOVERY_HOLD']);

const asText = (value: unknown, max = 400): string =>
  typeof value === 'string' ? value.slice(0, max) : value === undefined || value === null ? '' : String(value).slice(0, max);

const shortId = (id: unknown): string => {
  const text = asText(id, 128);
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
};

const objectRow = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.slice(0, 400);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(objectRow).filter(Boolean).join(', ').slice(0, 400);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.summary === 'string') return record.summary.slice(0, 400);
    return Object.entries(record)
      .map(([key, entry]) => `${key}: ${objectRow(entry)}`)
      .join(' · ')
      .slice(0, 400);
  }
  return '';
};

interface PendingOperation {
  body: Record<string, unknown>;
  label: string;
}

export function mountProjectToolManager(args: ProjectToolManagerArgs): ProjectToolManager {
  const { container, getToken, workspace_id, project_id, onOpen } = args;
  const root = el('section', 'project-tool-manager');
  root.setAttribute('aria-label', 'Project tools');
  root.append(el('h4', 'project-tool-manager-title', 'Project tools'));

  const status = el('p', 'project-tool-manager-status', 'Loading project tools…');
  status.setAttribute('role', 'status');
  const pendingView = el('div', 'project-tool-manager-pending');
  pendingView.setAttribute('role', 'alert');
  pendingView.hidden = true;
  const create = el('details', 'project-tool-create');
  create.append(el('summary', '', 'Create project tool'));
  const list = el('div', 'project-tool-manager-list');
  const details = el('details', 'project-tool-manager-details');
  details.append(el('summary', '', 'Limits and registered definitions'));

  const kindSelect = el('select', 'project-tool-kind');
  kindSelect.setAttribute('aria-label', 'New project tool kind');
  for (const [value, label] of Object.entries(PROJECT_TOOL_KIND_LABELS)) {
    const option = el('option', '', label);
    option.value = value;
    kindSelect.append(option);
  }
  const titleInput = el('input', 'project-tool-title');
  titleInput.setAttribute('aria-label', 'New project tool title');
  titleInput.placeholder = 'Tool title';
  titleInput.maxLength = 60;
  const releaseSelect = el('select', 'project-tool-release-select');
  releaseSelect.setAttribute('aria-label', 'New project tool release');
  const previewButton = button('Preview project tool', 'Preview the exact staged tool before creating it', () => void previewCreate(), 'project-tool-preview-button');
  const previewView = el('div', 'project-tool-preview');
  const commitStatus = el('p', 'project-tool-commit-status', '');
  commitStatus.setAttribute('role', 'status');
  const commitButton = button('Create project tool', 'Commit the previewed project tool (server stages its pane)', () => void commitCreate(), 'project-tool-commit-button');
  commitButton.disabled = true;
  create.append(
    labelWrap('Kind', kindSelect),
    labelWrap('Title', titleInput),
    labelWrap('Release (optional)', releaseSelect),
    previewButton,
    previewView,
    commitStatus,
    commitButton,
  );

  root.append(status, pendingView, create, list, details);
  container.replaceChildren(root);

  let disposed = false;
  let metadata: ProjectToolMetadata = { definitions: [], releases: [], instances: [], legacy_plugins: [], limits: {} };
  let preview: ProjectToolPreviewResult | null = null;
  let previewBaseRevision = 0;
  const controllers = new Set<AbortController>();
  const pendingOps = new Map<string, PendingOperation>();
  let acknowledgedInstance: string | null = null;

  function request<T>(body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    controllers.add(controller);
    return projectToolsRequest<T>(body, { token: getToken(), workspaceId: workspace_id, signal: controller.signal }).finally(() => {
      controllers.delete(controller);
    });
  }

  function notice(kind: string, message: string): void {
    status.textContent = message;
    status.dataset.state = kind;
  }

  function renderPending(): void {
    pendingView.replaceChildren();
    if (!pendingOps.size) {
      pendingView.hidden = true;
      return;
    }
    pendingView.hidden = false;
    pendingView.append(el('p', '', 'A mutation outcome is unknown. Retry only with the exact same operation key and payload.'));
    for (const [key, operation] of pendingOps) {
      const retry = button(`Retry “${operation.label}”`, 'Resend the exact retained operation', () => void retryOperation(key), 'project-tool-retry');
      pendingView.append(el('p', 'project-tool-pending-row', `${operation.label} · ${shortId(key)}`), retry);
    }
  }

  async function retryOperation(key: string): Promise<void> {
    const operation = pendingOps.get(key);
    if (!operation || disposed) return;
    try {
      const result = await request<Record<string, unknown>>(operation.body);
      pendingOps.delete(key);
      renderPending();
      notice('ready', `Retried “${operation.label}”.`);
      await handleMutationResult(operation.label, result);
    } catch (error) {
      if (disposed) return;
      if (error instanceof ProjectToolRequestError && error.unknownOutcome) {
        notice('unknown', `“${operation.label}” outcome is still unknown; the same key is retained.`);
      } else {
        pendingOps.delete(key);
        renderPending();
        notice('error', describe(error));
      }
    }
  }

  function describe(error: unknown): string {
    if (error instanceof ProjectToolRequestError) return `Project tool request failed (${error.code}).`;
    return 'Project tool request failed.';
  }

  async function handleMutationResult(label: string, result: Record<string, unknown>): Promise<void> {
    const instance = result.instance as ProjectToolInstance | undefined;
    if (instance?.id) emitChanged(instance.id);
    notice('ready', `${label} accepted${instance?.id ? ` · ${shortId(instance.id)}` : ''}.`);
    await refresh();
  }

  async function mutate(label: string, body: Record<string, unknown>): Promise<void> {
    if (disposed) return;
    const op_id = crypto.randomUUID();
    const intent = label;
    const payload = { ...body, op_id, intent };
    notice('loading', `${label}…`);
    try {
      const result = await request<Record<string, unknown>>(payload);
      pendingOps.delete(op_id);
      renderPending();
      const value = result as { instance?: ProjectToolInstance };
      if (value.instance?.id) emitChanged(value.instance.id);
      notice('ready', `${label} accepted.`);
      await refresh();
    } catch (error) {
      if (disposed) return;
      if (error instanceof ProjectToolRequestError && error.unknownOutcome) {
        pendingOps.set(op_id, { body: payload, label });
        renderPending();
        notice('unknown', `${label} outcome unknown; the exact key and payload are retained for retry.`);
        return;
      }
      const code = error instanceof ProjectToolRequestError ? error.code : 'unavailable';
      if (MUTATION_ERRORS.has(code)) {
        notice('conflict', `${label} was rejected (${code}). Read the current state before reconsidering; no automatic retry ran.`);
        await refresh();
        return;
      }
      notice('error', `${label} failed (${code}).`);
    }
  }

  function emitChanged(instanceId: string): void {
    window.dispatchEvent(
      new CustomEvent(PROJECT_TOOL_CHANGED_EVENT, { detail: { workspace_id, project_id, instance_id: instanceId } }),
    );
  }

  function labelWrap(name: string, control: HTMLElement): HTMLLabelElement {
    const label = el('label', 'project-tool-field');
    label.append(el('span', '', `${name} `), control);
    return label;
  }

  function definitionFor(kind: ProjectToolKind): ProjectToolDefinition | undefined {
    return metadata.definitions.find(definition => definition.kind === kind) ?? metadata.definitions.find(definition => definition.id === kind);
  }

  function releasesFor(kind: ProjectToolKind): ProjectToolRelease[] {
    const definition = definitionFor(kind);
    const byDefinition = metadata.releases.filter(release => definition && release.definition_id === definition.id);
    const releases = byDefinition.length ? byDefinition : metadata.releases.filter(release => release.kind === kind);
    return releases.filter(release => release.status === 'available');
  }

  function renderReleaseOptions(): void {
    const kind = kindSelect.value as ProjectToolKind;
    const releases = releasesFor(kind);
    releaseSelect.replaceChildren();
    const latest = el('option', '', 'Latest available');
    latest.value = '';
    releaseSelect.append(latest);
    for (const release of releases) {
      const option = el('option', '', `${PROJECT_TOOL_KIND_LABELS[kind] ?? kind} · release ${release.release} (renderer v${release.render_version})`);
      option.value = release.id;
      releaseSelect.append(option);
    }
    releaseSelect.disabled = releases.length === 0;
  }

  async function baseRevision(): Promise<number> {
    await ensureWorkspaceSynced();
    const token = getToken();
    const response = await workspaceFetch(token, { action: 'read', workspace_id });
    const value = (await response.json()) as { revision?: number };
    if (!response.ok) throw new Error('workspace_read_failed');
    if (!Number.isSafeInteger(value.revision)) throw new Error('workspace_read_failed');
    if (token !== getToken()) throw new Error('stale_resource');
    return value.revision as number;
  }

  async function previewCreate(): Promise<void> {
    if (disposed) return;
    const title = titleInput.value.trim();
    if (!title) {
      notice('invalid', 'Enter a tool title before previewing.');
      return;
    }
    const kind = kindSelect.value as ProjectToolKind;
    preview = null;
    commitButton.disabled = true;
    previewView.replaceChildren();
    notice('loading', 'Staging an exact preview…');
    try {
      previewBaseRevision = await baseRevision();
      const result = await request<ProjectToolPreviewResult>({
        action: 'create_preview',
        project_id,
        kind,
        title,
        base_revision: previewBaseRevision,
        ...(releaseSelect.value ? { release_id: releaseSelect.value } : {}),
      });
      preview = result;
      renderPreview(result);
      commitButton.disabled = false;
      notice('ready', 'Preview staged. Confirm to create; nothing renders or runs yet.');
    } catch (error) {
      if (disposed) return;
      notice('error', `Preview failed (${error instanceof ProjectToolRequestError ? error.code : 'unavailable'}).`);
    }
  }

  function renderPreview(result: ProjectToolPreviewResult): void {
    previewView.replaceChildren();
    previewView.append(el('h5', '', 'Semantic preview'));
    const rows = Array.isArray(result.diff) ? result.diff : [];
    if (rows.length) {
      const list = el('ul', 'project-tool-diff');
      for (const row of rows) list.append(el('li', '', objectRow(row) || 'change'));
      previewView.append(list);
    } else {
      previewView.append(el('p', '', 'No semantic changes were reported for this staging.'));
    }
    previewView.append(
      el('p', 'project-tool-disclosure', `Not rendered and not tested by this preview. Expires ${new Date(result.expires_at).toISOString()}.`),
      el('p', 'project-tool-disclosure', `Preview digest ${asText(result.preview_digest)}`),
    );
  }

  async function commitCreate(): Promise<void> {
    if (disposed || !preview) return;
    if (preview.expires_at <= Date.now()) {
      commitButton.disabled = true;
      notice('expired', 'The preview expired. Stage a fresh preview before creating.');
      return;
    }
    const staged = preview;
    const op_id = crypto.randomUUID();
    const intent = 'Create project tool instance';
    const payload = {
      action: 'create_commit',
      project_id,
      preview_id: staged.preview_id,
      preview_digest: staged.preview_digest,
      op_id,
      intent,
    };
    commitButton.disabled = true;
    commitStatus.textContent = 'Creating…';
    try {
      const result = await request<{ instance?: ProjectToolInstance }>(payload);
      const instance = result.instance;
      if (!instance?.id) throw new Error('unavailable');
      const acknowledged = await pollInstance(instance.id);
      if (disposed) return;
      if (acknowledged) {
        commitStatus.textContent = `Created ${instance.title} · acknowledged by browser polling.`;
        preview = null;
        previewView.replaceChildren();
        emitChanged(instance.id);
        notifyOpen(instance);
      } else {
        commitStatus.textContent = `Created ${instance.title}, but no acknowledged metadata read arrived yet. Refresh the project to confirm.`;
      }
      titleInput.value = '';
      await refresh();
    } catch (error) {
      if (disposed) return;
      if (error instanceof ProjectToolRequestError && error.unknownOutcome) {
        pendingOps.set(op_id, { body: payload, label: intent });
        renderPending();
        commitStatus.textContent = 'Create outcome unknown; the exact preview commit key and payload are retained for retry.';
        return;
      }
      commitStatus.textContent = `Create failed (${error instanceof ProjectToolRequestError ? error.code : 'unavailable'}).`;
      commitButton.disabled = false;
    }
  }

  async function pollInstance(instanceId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 20 && !disposed; attempt++) {
      try {
        const value = await request<ProjectToolMetadata>({ action: 'metadata_list', project_id });
        const found = (value.instances ?? []).some(instance => instance.id === instanceId);
        if (found) return true;
      } catch {
        // Keep polling; the operation itself already succeeded or is unknown.
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, 250));
    }
    return false;
  }

  function notifyOpen(instance: ProjectToolInstance): void {
    if (onOpen) onOpen(instance);
    else window.dispatchEvent(new CustomEvent(PROJECT_TOOL_OPEN_EVENT, { detail: { workspace_id, project_id, instance_id: instance.id } }));
  }

  function openInstance(instance: ProjectToolInstance): void {
    notifyOpen(instance);
  }

  function instanceRow(instance: ProjectToolInstance): HTMLElement {
    const row = el('article', 'project-tool-row');
    row.dataset.instanceId = instance.id;
    const head = el('div', 'project-tool-row-head');
    head.append(
      el('strong', 'project-tool-row-title', asText(instance.title, 200) || 'Untitled tool'),
      el('span', 'project-tool-row-kind', PROJECT_TOOL_KIND_LABELS[instance.kind] ?? asText(instance.kind)),
      el('span', 'project-tool-row-state', instance.revoked ? 'revoked' : instance.enabled ? 'enabled' : 'disabled'),
      el('span', 'project-tool-row-release', `release ${shortId(instance.release_id)}`),
    );
    row.append(head);

    const configView = el('div', 'project-tool-config');
    configView.hidden = true;
    const font = el('input', 'project-tool-font');
    font.type = 'range';
    font.min = '12';
    font.max = '28';
    font.value = String(instance.config.font_size ?? 16);
    font.setAttribute('aria-label', 'Tool font size');
    const counts = el('input', 'project-tool-counts');
    counts.type = 'checkbox';
    counts.checked = instance.config.show_counts === true;
    counts.setAttribute('aria-label', 'Show counts');
    configView.append(
      labelWrap('Font size', font),
      labelWrap('Show counts', counts),
      button('Apply tool settings', 'Replace this instance’s settings only', () => void mutate('Configure project tool', {
        action: 'configure',
        project_id,
        instance_id: instance.id,
        expected_revision: instance.revision,
        config: { font_size: Number(font.value), show_counts: counts.checked },
      }), 'project-tool-configure-apply'),
    );

    const releaseView = el('div', 'project-tool-release');
    releaseView.hidden = true;
    const select = el('select', 'project-tool-release-choice');
    select.setAttribute('aria-label', 'Tool release');
    for (const release of releasesFor(instance.kind)) {
      const option = el('option', '', `release ${release.release} · renderer v${release.render_version} · ${shortId(release.id)}`);
      option.value = release.id;
      if (release.id === instance.release_id) option.selected = true;
      select.append(option);
    }
    releaseView.append(
      labelWrap('Release pin', select),
      el('p', 'project-tool-release-note', 'Changing the release changes the trusted renderer version only. Notebook text is never reverted.'),
      button('Apply tool release', 'Repin this instance to a release', () => void mutate('Repin project tool release', {
        action: 'repin',
        project_id,
        instance_id: instance.id,
        expected_revision: instance.revision,
        release_id: select.value,
      }), 'project-tool-release-apply'),
    );

    const actions = el('div', 'project-tool-row-actions');
    const enabled = instance.enabled && !instance.revoked;
    const toggle = button(
      enabled ? 'Disable' : 'Enable',
      enabled ? 'Disable this project tool' : 'Enable this project tool',
      () => void mutate(enabled ? 'Disable project tool' : 'Enable project tool', {
        action: 'set_enabled',
        project_id,
        instance_id: instance.id,
        expected_revision: instance.revision,
        enabled: !instance.enabled,
      }),
      'project-tool-toggle',
    );
    toggle.disabled = instance.revoked;
    const configure = button('Configure', 'Edit this instance’s own settings', () => {
      configView.hidden = !configView.hidden;
      releaseView.hidden = true;
    }, 'project-tool-configure');
    configure.disabled = instance.revoked;
    const releaseButton = button('Release', 'Change the renderer release pin (never notebook text)', () => {
      releaseView.hidden = !releaseView.hidden;
      configView.hidden = true;
    }, 'project-tool-release-toggle');
    releaseButton.disabled = instance.revoked;
    const revoke = button('Revoke', 'Terminally revoke this project tool', () => {
      if (!window.confirm('Revoke this project tool? This is one-way; the owner can never re-enable or reconfigure it.')) return;
      void mutate('Revoke project tool', {
        action: 'revoke',
        project_id,
        instance_id: instance.id,
        expected_revision: instance.revision,
      });
    }, 'project-tool-revoke');
    revoke.disabled = instance.revoked;
    const open = button('Open', 'Focus the bound pane for this tool', () => openInstance(instance), 'project-tool-open');
    actions.append(toggle, configure, releaseButton, revoke, open);
    row.append(actions);

    const ids = el('details', 'project-tool-ids');
    ids.append(
      el('summary', '', 'Identifiers'),
      el('p', '', `Instance ${asText(instance.id)}`),
      el('p', '', `Definition ${asText(instance.definition_id)}`),
      el('p', '', `Release ${asText(instance.release_id)}`),
      el('p', '', `Revision ${String(instance.revision)}`),
      el('p', '', `Project ${asText(instance.project_id)}`),
      el('p', '', `Updated ${new Date(instance.updated_at || instance.created_at || 0).toISOString()}`),
    );
    row.append(ids);
    row.append(configView, releaseView);

    return row;
  }

  function renderDetails(): void {
    details.replaceChildren(el('summary', '', 'Limits and registered definitions'));
    details.append(el('p', '', `Definitions: ${metadata.definitions.map(definition => `${definition.kind} (${lengthOf(definition.releases)} releases)`).join(', ') || 'none'}`));
    details.append(el('p', '', `Limits: ${objectRow(metadata.limits) || 'not reported'}`));
    if (metadata.legacy_plugins.length) {
      details.append(el('p', '', `Legacy plugins visible to the server: ${metadata.legacy_plugins.length}. They are reported by id only and are not convertible to a project tool.`));
    }
  }

  function lengthOf(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
  }

  function renderList(): void {
    list.replaceChildren();
    const instances = metadata.instances.filter(instance => instance.project_id === project_id);
    if (!instances.length) {
      list.append(el('p', 'project-tool-empty', 'No project tools exist for this project yet.'));
      return;
    }
    for (const instance of instances) list.append(instanceRow(instance));
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    if (!getToken()) {
      notice('locked', 'Connect the owner workspace to manage project tools.');
      list.replaceChildren(el('p', 'project-tool-empty', 'Unlock to list project tools.'));
      return;
    }
    try {
      const value = await request<ProjectToolMetadata>({ action: 'metadata_list', project_id });
      if (disposed) return;
      metadata = {
        definitions: Array.isArray(value.definitions) ? value.definitions : [],
        releases: Array.isArray(value.releases) ? value.releases : [],
        instances: Array.isArray(value.instances) ? value.instances : [],
        legacy_plugins: Array.isArray(value.legacy_plugins) ? value.legacy_plugins : [],
        limits: value.limits && typeof value.limits === 'object' ? value.limits : {},
      };
      renderReleaseOptions();
      renderList();
      renderDetails();
      notice('ready', `${metadata.instances.filter(instance => instance.project_id === project_id).length} project tools for this project.`);
    } catch (error) {
      if (disposed) return;
      const code = error instanceof ProjectToolRequestError ? error.code : 'unavailable';
      notice(code === 'permission_denied' ? 'error' : 'unavailable', `Project tools unavailable (${code}).`);
      list.replaceChildren(el('p', 'project-tool-empty', 'No project tool metadata was read.'));
    }
  }

  kindSelect.addEventListener('change', renderReleaseOptions);
  renderPending();
  commitButton.disabled = true;
  if (!getToken()) notice('locked', 'Connect the owner workspace to manage project tools.');
  else void refresh();

  return {
    refresh,
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      pendingOps.clear();
      preview = null;
      root.remove();
    },
  };
}

/**
 * Focus an existing bound project-tool pane.
 *
 * There is deliberately no "reopen a closed pane" path here: the frozen API
 * stages a pane only at create time. A closed pane is restored through the
 * normal window/checkpoint restore flow, not by silently adding an unbound pane.
 */
export async function openProjectToolPane(instanceId: string, getToken: () => string, workspaceIdArg = workspaceId): Promise<'focused' | 'missing'> {
  const token = getToken();
  if (!token) return 'missing';
  await ensureWorkspaceSynced();
  const response = await workspaceFetch(token, { action: 'read', workspace_id: workspaceIdArg });
  if (!response.ok) return 'missing';
  const value = (await response.json()) as { state?: { monitors?: Array<{ id: string; layout?: unknown }> } };
  if (token !== getToken()) return 'missing';
  const matches: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as { type?: string; pane?: { id?: string; url?: string }; first?: unknown; second?: unknown };
    if (record.type === 'pane') {
      if (record.pane?.url && projectToolId(record.pane.url) === instanceId && record.pane.id) matches.push(record.pane.id);
      return;
    }
    visit(record.first);
    visit(record.second);
  };
  for (const monitor of value.state?.monitors ?? []) visit(monitor.layout);
  const paneId = matches[0];
  if (!paneId) return 'missing';
  window.dispatchEvent(
    new CustomEvent(PROJECT_TOOL_OPEN_EVENT, { detail: { workspace_id: workspaceIdArg, instance_id: instanceId, pane_id: paneId, url: projectToolUrl(instanceId) } }),
  );
  return 'focused';
}
