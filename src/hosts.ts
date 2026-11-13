import './hosts.css';
import { button, el, select } from './dom';

export type HostPermission = 'none' | 'read' | 'deploy' | 'admin';
export type HostTransport = 'direct' | 'proxyJump' | 'tailscale' | 'tailcat' | 'cloudflare';
export type HostState = 'verified' | 'key-changed' | 'unreachable' | 'revoked' | string;

export interface HostView {
  id: string;
  label: string;
  address: string;
  port: number;
  user: string;
  tags: string[];
  roles: string[];
  transport: { kind: HostTransport; jumpHostId: string | null; cloudflareHostname?: string | null };
  auth: { kind: string; keyId: string };
  hostKey: { fingerprints: string[]; pinnedAt: string | null; verifiedBy: string | null };
  privilege: { sudo: string; docker: string; forcedCommand: boolean; terminal: boolean };
  permissions: Record<string, HostPermission>;
  status: { state: HostState; lastSeen: string | null };
  permission: HostPermission;
  keyInUse: string;
}

export interface HostsRequest {
  (body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface HostsOptions {
  token?: () => string;
  request?: HostsRequest;
}

export interface HostsMount extends HostsOptions {
  onClose?: () => void;
}

export interface HostsWizardStepOptions extends HostsOptions {
  onSkip?: () => void;
  onDone?: (host: HostView | null) => void;
}

const PERMISSIONS: HostPermission[] = ['none', 'read', 'deploy', 'admin'];
const AGENTS: [string, string][] = [
  ['setup', 'Setup agent'],
  ['pi', 'Pi'],
  ['opencode', 'OpenCode'],
  ['hermes', 'Hermes'],
  ['bundlebees', 'Bundlebees deployer'],
];
const TRANSPORTS: [HostTransport, string, string][] = [
  ['direct', 'Direct', 'Connect to the address over SSH.'],
  ['proxyJump', 'ProxyJump through another Orbit host', 'Use an existing verified host as the jump host.'],
  ['tailscale', 'Tailscale', 'Use a MagicDNS name on your own tailnet.'],
  ['tailcat', 'tailcat (untested)', 'UNTESTED: a tailcat ProxyCommand transport. The address is stored as a 0600 file ref.'],
  ['cloudflare', 'Cloudflare Access (untested)', 'ProxyCommand cloudflared access ssh. The transport is marked untested.'],
];

function requestFor(options: HostsOptions): HostsRequest {
  if (options.request) return options.request;
  const token = options.token ?? (() => '');
  return async body => {
    const response = await fetch('/api/hosts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data: unknown = await response.json().catch(() => ({}));
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    if (!response.ok || record.ok === false) {
      const message = typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : `Host request failed (${response.status}).`;
      throw new Error(message);
    }
    return record;
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Host request failed.';
}

function lines(value: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
  return fallback;
}

function hostOf(value: unknown): HostView | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  if (!id) return null;
  const transportValue = record.transport && typeof record.transport === 'object' ? record.transport as Record<string, unknown> : {};
  const auth = record.auth && typeof record.auth === 'object' ? record.auth as Record<string, unknown> : {};
  const hostKey = record.hostKey && typeof record.hostKey === 'object' ? record.hostKey as Record<string, unknown> : {};
  const privilege = record.privilege && typeof record.privilege === 'object' ? record.privilege as Record<string, unknown> : {};
  const status = record.status && typeof record.status === 'object' ? record.status as Record<string, unknown> : {};
  return {
    id,
    label: typeof record.label === 'string' ? record.label : id,
    address: typeof record.address === 'string' ? record.address : '',
    port: typeof record.port === 'number' ? record.port : 22,
    user: typeof record.user === 'string' ? record.user : 'orbit',
    tags: lines(record.tags),
    roles: lines(record.roles),
    transport: {
      kind: (['direct', 'proxyJump', 'tailscale', 'tailcat', 'cloudflare'].includes(String(transportValue.kind)) ? String(transportValue.kind) : 'direct') as HostTransport,
      jumpHostId: typeof transportValue.jumpHostId === 'string' ? transportValue.jumpHostId : null,
    },
    auth: { kind: typeof auth.kind === 'string' ? auth.kind : 'orbit-key', keyId: typeof auth.keyId === 'string' ? auth.keyId : 'orbit-default' },
    hostKey: {
      fingerprints: lines(hostKey.fingerprints),
      pinnedAt: typeof hostKey.pinnedAt === 'string' ? hostKey.pinnedAt : null,
      verifiedBy: typeof hostKey.verifiedBy === 'string' ? hostKey.verifiedBy : null,
    },
    privilege: {
      sudo: typeof privilege.sudo === 'string' ? privilege.sudo : 'none',
      docker: typeof privilege.docker === 'string' ? privilege.docker : 'none',
      forcedCommand: privilege.forcedCommand === true,
      terminal: privilege.terminal === true,
    },
    permissions: record.permissions && typeof record.permissions === 'object' ? record.permissions as Record<string, HostPermission> : {},
    status: {
      state: typeof status.state === 'string' ? status.state : 'verified',
      lastSeen: typeof status.lastSeen === 'string' ? status.lastSeen : null,
    },
    permission: PERMISSIONS.includes(record.permission as HostPermission) ? record.permission as HostPermission : 'none',
    keyInUse: typeof record.keyInUse === 'string' ? record.keyInUse : (typeof auth.keyId === 'string' ? auth.keyId : 'orbit-default'),
  };
}

function hostListOf(value: unknown): HostView[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const list = Array.isArray(record.hosts) ? record.hosts : Array.isArray(value) ? value : [];
  return list.map(hostOf).filter((host): host is HostView => host !== null);
}

function copyButton(text: string, label: string): HTMLButtonElement {
  return button(label, `Copy ${label}`, () => {
    void navigator.clipboard?.writeText(text);
  }, 'hosts-copy');
}

function field(label: string, control: HTMLElement, hint = ''): HTMLLabelElement {
  const node = el('label', 'hosts-field');
  node.append(el('span', 'hosts-field-label', label), control);
  if (hint) node.append(el('small', 'hosts-hint', hint));
  return node;
}

function textInput(placeholder: string, value = ''): HTMLInputElement {
  const input = el('input', 'hosts-input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = value;
  return input;
}

function textArea(placeholder: string, value = ''): HTMLTextAreaElement {
  const area = el('textarea', 'hosts-textarea') as HTMLTextAreaElement;
  area.placeholder = placeholder;
  area.value = value;
  area.spellcheck = false;
  return area;
}

function statusBadge(host: HostView): HTMLElement {
  const badge = el('span', 'hosts-status', host.status.state);
  badge.dataset.state = host.status.state;
  badge.textContent = host.status.state.replaceAll('-', ' ');
  return badge;
}

function transportLabel(kind: HostTransport): string {
  if (kind === 'tailcat') return 'tailcat · untested transport';
  if (kind === 'cloudflare') return 'Cloudflare Access · untested transport';
  if (kind === 'proxyJump') return 'ProxyJump';
  if (kind === 'tailscale') return 'Tailscale';
  return 'Direct';
}

async function fetchAudit(request: HostsRequest, hostId: string): Promise<{ entries: Record<string, unknown>[]; valid: boolean; head: string | null; error: string | null }> {
  const data = await request({ action: 'audit', hostId });
  const raw = Array.isArray(data.entries) ? data.entries : [];
  const entries = raw.filter(item => item && typeof item === 'object') as Record<string, unknown>[];
  return {
    entries,
    valid: data.valid !== false,
    head: typeof data.head === 'string' ? data.head : null,
    error: typeof data.error === 'string' ? data.error : null,
  };
}

function auditRow(entry: Record<string, unknown>): HTMLElement {
  const row = el('li', 'hosts-audit-row');
  const head = el('div', 'hosts-audit-head');
  head.append(
    el('span', 'hosts-audit-time', typeof entry.time === 'string' ? entry.time : ''),
    el('span', 'hosts-audit-agent', typeof entry.agent === 'string' ? entry.agent : 'agent'),
    el('span', 'hosts-audit-exit', `exit ${entry.exitCode === null || entry.exitCode === undefined ? '—' : String(entry.exitCode)}`),
  );
  const argv = el('code', 'hosts-audit-argv', Array.isArray(entry.argv) ? entry.argv.map(String).join(' ') : '');
  row.append(head, argv);
  const meta: string[] = [];
  if (typeof entry.durationMs === 'number') meta.push(`${entry.durationMs} ms`);
  if (typeof entry.outputBytes === 'number') meta.push(`${entry.outputBytes} bytes`);
  if (typeof entry.approvalId === 'string' && entry.approvalId) meta.push(`approval ${entry.approvalId}`);
  if (typeof entry.status === 'string') meta.push(entry.status);
  if (meta.length) row.append(el('small', 'hosts-audit-meta', meta.join(' · ')));
  if (typeof entry.outputTail === 'string' && entry.outputTail) row.append(el('pre', 'hosts-audit-tail', entry.outputTail));
  return row;
}

function openAuditDialog(host: HostView, request: HostsRequest): void {
  const dialog = el('dialog', 'hosts-dialog hosts-audit-dialog');
  dialog.setAttribute('aria-label', `Audit log for ${host.label}`);
  const head = el('div', 'hosts-dialog-head');
  const close = button('Close', 'Close audit log', () => dialog.close(), 'small-button');
  head.append(el('h2', '', `Audit · ${host.label}`), close);
  const status = el('p', 'hosts-note', 'Reading the append-only log…');
  const list = el('ol', 'hosts-audit-list');
  dialog.append(head, status, list);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  void fetchAudit(request, host.id).then(result => {
    status.textContent = result.valid
      ? `${result.entries.length} entries · hash chain verified${result.head ? ` · head ${result.head.slice(0, 12)}…` : ''}`
      : `Hash chain NOT verified: ${result.error ?? 'the log was modified.'} Entries are shown read-only.`;
    status.dataset.invalid = String(!result.valid);
    list.replaceChildren(...result.entries.map(auditRow));
    if (!result.entries.length) list.append(el('li', 'hosts-note', 'No commands recorded for this host.'));
  }).catch(error => {
    status.textContent = errorText(error);
    status.dataset.invalid = 'true';
  });
}

function openRemoveDialog(host: HostView, request: HostsRequest, done: () => void): void {
  const dialog = el('dialog', 'hosts-dialog');
  dialog.setAttribute('aria-label', `Remove access to ${host.label}`);
  const head = el('div', 'hosts-dialog-head');
  head.append(el('h2', '', `Remove access · ${host.label}`), button('Close', 'Close', () => dialog.close(), 'small-button'));
  const warning = el('p', 'hosts-warning', 'Orbit removes its local host entry, known-host pin and key refs. The worker token is revoked independently. Audit history is kept.');
  const cleanupLabel = el('label', 'hosts-check');
  const cleanup = el('input') as HTMLInputElement;
  cleanup.type = 'checkbox';
  cleanupLabel.append(cleanup, el('span', '', 'Also try to remove the worker and the Orbit key line on the remote host (untested)'));
  const untested = el('p', 'hosts-note', 'UNTESTED: remote authorized_keys cleanup. Orbit cannot guarantee what a remote host retains; remove the printed key line manually if this fails.');
  const status = el('p', 'hosts-error');
  const confirm = button('Remove access', 'Remove this host from Orbit', async () => {
    confirm.disabled = true;
    try {
      await request({ action: 'remove', hostId: host.id, remoteCleanup: cleanup.checked });
      dialog.close();
      done();
    } catch (error) {
      status.textContent = errorText(error);
    } finally {
      confirm.disabled = false;
    }
  }, 'hosts-danger');
  dialog.append(head, warning, cleanupLabel, untested, status, confirm);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

function permissionsBlock(host: HostView, request: HostsRequest, refresh: () => void): HTMLElement {
  const details = el('details', 'hosts-permissions');
  details.append(el('summary', '', 'Agent permissions'));
  details.append(el('p', 'hosts-hint', 'Every agent starts at none. Raising an agent to deploy or admin is an explicit choice; deploy is never enabled by default.'));
  const grid = el('div', 'hosts-permission-grid');
  for (const [id, label] of AGENTS) {
    const current = host.permissions[id] ?? 'none';
    const control = select(PERMISSIONS.map(level => [level, level] as [string, string]), current, async value => {
      if (value === 'deploy' || value === 'admin') {
        const allows = value === 'deploy'
          ? 'Deploy allows named recipes and an allow-list of provisioning commands.'
          : 'Admin allows raw commands; destructive commands still need owner approval.';
        if (!confirm(`Give ${label} ${value} access on ${host.label}? ${allows}`)) {
          control.value = current;
          return;
        }
      }
      try {
        await request({ action: 'permissions', hostId: host.id, permissions: { ...host.permissions, [id]: value }, ...(value === 'deploy' || value === 'admin' ? { confirm: true } : {}) });
        refresh();
      } catch (error) {
        control.value = current;
        details.append(el('p', 'hosts-error', errorText(error)));
      }
    });
    control.setAttribute('aria-label', `${label} permission on ${host.label}`);
    const row = el('label', 'hosts-permission-row');
    row.append(el('span', '', label), control);
    grid.append(row);
  }
  details.append(grid);
  return details;
}

function card(host: HostView, request: HostsRequest, refresh: () => void): HTMLElement {
  const cardNode = el('article', 'hosts-card');
  cardNode.dataset.state = host.status.state;
  const head = el('div', 'hosts-card-head');
  head.append(el('h3', '', host.label), statusBadge(host));
  const facts = el('dl', 'hosts-facts');
  const add = (term: string, value: string) => {
    facts.append(el('dt', '', term), el('dd', '', value));
  };
  add('Address', `${host.user}@${host.address}:${host.port}`);
  add('Roles', host.roles.length ? host.roles.join(', ') : '—');
  add('Transport', transportLabel(host.transport.kind));
  add('Key in use', host.keyInUse);
  add('Last seen', host.status.lastSeen ? new Date(host.status.lastSeen).toLocaleString() : '—');
  add('Your permission', host.permission);
  cardNode.append(head, facts);
  if (host.status.state === 'key-changed') {
    cardNode.append(el('p', 'hosts-warning', 'The host key changed. Every action is blocked until you compare the new fingerprint with the host and confirm the pin.'));
  }
  if (host.status.state === 'revoked') {
    cardNode.append(el('p', 'hosts-warning', 'This host is revoked locally. Its audit history is retained.'));
  }
  const actions = el('div', 'hosts-card-actions');
  actions.append(
    button('Test connection', 'Connect and show the host fingerprint for verification', () => openTest(host, request), 'small-button'),
    button('Revoke host', 'Revoke this host immediately; all agent actions are blocked', async () => {
      try {
        await request({ action: 'revoke', hostId: host.id });
        refresh();
      } catch (error) {
        cardNode.append(el('p', 'hosts-error', errorText(error)));
      }
    }, 'small-button hosts-danger'),
    button('Remove access…', 'Remove this host from Orbit', () => openRemoveDialog(host, request, refresh), 'small-button'),
    button('Audit log', 'Read the append-only per-host audit log', () => openAuditDialog(host, request), 'small-button'),
  );
  cardNode.append(actions, permissionsBlock(host, request, refresh));
  return cardNode;
}

function authorizationPanel(host: HostView, material: Record<string, unknown>, request: HostsRequest, onPinned?: () => void): HTMLElement {
  const panel = el('section', 'hosts-authorize');
  panel.append(
    el('h3', '', 'Authorize Orbit on the host'),
    el('p', 'hosts-note', 'Paste one of these as the dedicated orbit user. Private keys never leave Orbit and are never shown here.'),
  );
  const authorized = typeof material.authorizedKeysLine === 'string' ? material.authorizedKeysLine : typeof material.authorized_keys_line === 'string' ? material.authorized_keys_line : '';
  if (authorized) {
    const area = textArea('restrict,pty ssh-ed25519 … orbit-<installId>', authorized);
    area.readOnly = true;
    area.rows = 2;
    panel.append(field('Restricted authorized_keys line', area), copyButton(authorized, 'authorized_keys line'));
  }
  const oneLiner = typeof material.bootstrapOneLiner === 'string' ? material.bootstrapOneLiner : typeof material.bootstrap_one_liner === 'string' ? material.bootstrap_one_liner : '';
  if (oneLiner) {
    const code = el('code', 'hosts-code', oneLiner);
    const pre = el('pre', 'hosts-pre');
    pre.append(code);
    panel.append(el('h4', '', 'Bootstrap one-liner'), pre, copyButton(oneLiner, 'bootstrap one-liner'));
  }
  const script = typeof material.bootstrapScript === 'string' ? material.bootstrapScript : typeof material.bootstrap_script === 'string' ? material.bootstrap_script : '';
  if (script) {
    const details = el('details', 'hosts-script');
    details.append(el('summary', '', 'Show the full bootstrap script'), el('pre', 'hosts-pre', script));
    panel.append(details, copyButton(script, 'bootstrap script'));
  }
  panel.append(el('p', 'hosts-note', 'The bootstrap prints the host ed25519 fingerprint. Test the connection below, then confirm that the fingerprint Orbit saw matches it.'));

  const result = el('div', 'hosts-fingerprint');
  const fingerprint = el('code', 'hosts-fingerprint-value', 'Test the connection to see the fingerprint.');
  const compare = el('p', 'hosts-note', 'Compare with the fingerprint the bootstrap printed. Do not confirm a fingerprint you have not checked.');
  const confirm = button('Confirm pin', 'Pin the fingerprint shown by this test', async () => {
    const value = result.dataset.fingerprint || '';
    if (!value) return;
    confirm.disabled = true;
    try {
      await request({ action: 'confirm-pin', hostId: host.id, fingerprint: value });
      result.append(el('p', 'hosts-ok', 'Fingerprint pinned. StrictHostKeyChecking stays enabled for every action.'));
      result.dataset.confirmed = 'true';
      onPinned?.();
    } catch (error) {
      result.append(el('p', 'hosts-error', errorText(error)));
    } finally {
      confirm.disabled = false;
    }
  }, 'hosts-confirm');
  confirm.disabled = true;
  const test = button('Test connection', 'Connect without running any command and show the host fingerprint', async () => {
    test.disabled = true;
    confirm.disabled = true;
    compare.dataset.state = '';
    try {
      const data = await request({ action: 'test', hostId: host.id });
      const seen = typeof data.fingerprint === 'string' ? data.fingerprint : Array.isArray(data.fingerprints) ? String(data.fingerprints[0] ?? '') : '';
      const previous = typeof data.previousFingerprint === 'string' ? data.previousFingerprint : '';
      result.dataset.fingerprint = seen;
      fingerprint.textContent = seen || 'No fingerprint was returned.';
      compare.textContent = 'Compare with the fingerprint the bootstrap printed. Do not confirm a fingerprint you have not checked.';
      if (previous && seen && previous !== seen) {
        compare.textContent = `The host presented a changed key. Previous: ${previous}. New: ${seen}. Confirm only after checking the host out-of-band.`;
        compare.dataset.state = 'changed';
      }
      if (seen) confirm.disabled = false;
    } catch (error) {
      fingerprint.textContent = 'Connection test failed.';
      compare.textContent = errorText(error);
      compare.dataset.state = 'error';
    } finally {
      test.disabled = false;
    }
  });
  result.append(fingerprint, compare, el('div', 'hosts-actions', ''));
  (result.lastElementChild as HTMLElement).append(test, confirm);
  panel.append(result);
  return panel;
}

function openTest(host: HostView, request: HostsRequest): void {
  const dialog = el('dialog', 'hosts-dialog');
  dialog.setAttribute('aria-label', `Test connection to ${host.label}`);
  const head = el('div', 'hosts-dialog-head');
  head.append(el('h2', '', `Test connection · ${host.label}`), button('Close', 'Close', () => dialog.close(), 'small-button'));
  const panel = authorizationPanel(host, {}, request);
  dialog.append(head, panel);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

interface AddFormOptions {
  request: HostsRequest;
  hosts: HostView[];
  onAdded: (host: HostView | null, material: Record<string, unknown>) => void;
  onRefresh: () => void;
}

interface AddFormHandle {
  element: HTMLElement;
  setHosts(hosts: HostView[]): void;
}

function addForm(options: AddFormOptions): AddFormHandle {
  const { request, hosts, onAdded, onRefresh } = options;
  const form = el('form', 'hosts-add-form');
  form.addEventListener('submit', event => event.preventDefault());
  const address = textInput('orbit@203.0.113.10 or orbit@host:port');
  address.setAttribute('aria-label', 'Host address');
  const label = textInput('Build box (optional)');
  label.setAttribute('aria-label', 'Host label');
  const tags = textInput('eu, lab');
  tags.setAttribute('aria-label', 'Host tags');
  const roles = textInput('worker, infra');
  roles.setAttribute('aria-label', 'Host roles');
  const transport = select(TRANSPORTS.map(([value, text]) => [value, text] as [string, string]), 'direct', () => updateTransport());
  transport.setAttribute('aria-label', 'Transport');

  const transportFields = el('div', 'hosts-transport-fields');
  const jump = select([['', 'Choose a verified host']], '', () => {});
  jump.setAttribute('aria-label', 'ProxyJump host');
  const setHosts = (list: HostView[]) => {
    const current = jump.value;
    jump.replaceChildren();
    const none = el('option', '', 'Choose a verified host') as HTMLOptionElement;
    none.value = '';
    jump.append(none);
    for (const item of list.filter(candidate => candidate.transport.kind !== 'tailcat')) {
      const option = el('option', '', item.label) as HTMLOptionElement;
      option.value = item.id;
      jump.append(option);
    }
    jump.value = list.some(item => item.id === current) ? current : '';
  };
  setHosts(hosts);
  const tailcat = textInput('Paste the tailcat address');
  tailcat.type = 'password';
  tailcat.autocomplete = 'off';
  tailcat.setAttribute('aria-label', 'tailcat address');
  const cloudflare = textInput('ssh.example.com');
  cloudflare.setAttribute('aria-label', 'Cloudflare Access hostname');
  const tailcatField = field('tailcat address (stored as a 0600 file ref)', tailcat, 'UNTESTED transport. Treat this address as a bearer secret; Orbit never returns it to agents.');
  const jumpField = field('Jump host', jump);
  const cloudflareField = field('Cloudflare Access hostname', cloudflare, 'UNTESTED transport.');
  transportFields.append(jumpField, tailcatField, cloudflareField);
  const updateTransport = () => {
    jumpField.hidden = transport.value !== 'proxyJump';
    tailcatField.hidden = transport.value !== 'tailcat';
    cloudflareField.hidden = transport.value !== 'cloudflare';
  };
  updateTransport();

  const importArea = textArea('Paste an ssh_config snippet. Orbit imports HostName, User, Port, ProxyJump and the IdentityFile path only.', '');
  importArea.rows = 4;
  const importDetails = el('details', 'hosts-import');
  importDetails.append(el('summary', '', 'Import from ssh config'), importArea);
  const status = el('p', 'hosts-error');
  const submit = el('button', 'hosts-primary') as HTMLButtonElement;
  submit.type = 'submit';
  submit.textContent = 'Add host';
  submit.onclick = async () => {
    submit.disabled = true;
    status.textContent = '';
    try {
      const config = importArea.value.trim();
      const body = config
        ? { action: 'import', config }
        : {
          action: 'add',
          address: address.value.trim(),
          label: label.value.trim(),
          tags: lines(tags.value),
          roles: lines(roles.value),
          transport: {
            kind: transport.value,
            jumpHostId: jump.value || null,
            tailcatAddr: tailcat.value.trim(),
            cloudflareHostname: cloudflare.value.trim(),
          },
        };
      const data = await request(body);
      const added = hostOf(data.host) ?? hostListOf(data)[0] ?? null;
      const material = data.authorization && typeof data.authorization === 'object' ? data.authorization as Record<string, unknown> : data;
      onAdded(added, material);
      onRefresh();
      importArea.value = '';
    } catch (error) {
      status.textContent = errorText(error);
    } finally {
      submit.disabled = false;
    }
  };

  form.append(
    field('Address', address, 'Paste user@host or user@host:port. Defaults: user orbit, port 22.'),
    field('Label', label),
    field('Tags', tags, 'Comma separated, free-form.'),
    field('Roles', roles, 'Comma separated: worker, infra, build.'),
    field('Transport', transport),
    transportFields,
    importDetails,
    status,
    submit,
  );
  return { element: form, setHosts };
}

export function renderHostsWizardStep(options: HostsWizardStepOptions = {}): HTMLElement {
  const request = requestFor(options);
  const section = el('section', 'hosts-wizard-step');
  section.append(
    el('h2', '', 'Add your first host (optional)'),
    el('p', 'hosts-note', 'Connect a machine for infrastructure deploys or workers. You can skip this now and add hosts later in Settings → Hosts.'),
  );
  const result = el('div', 'hosts-wizard-result');
  const form = addForm({
    request,
    hosts: [],
    onAdded: (host, material) => {
      result.replaceChildren();
      if (host) result.append(authorizationPanel(host, material, request));
      else result.append(el('p', 'hosts-ok', 'Host imported. Open Settings → Hosts to verify it.'));
      options.onDone?.(host);
    },
    onRefresh: () => {},
  });
  const skip = button('Skip for now', 'Skip adding a host', () => options.onSkip?.(), 'small-button');
  const footer = el('div', 'hosts-actions');
  footer.append(skip);
  section.append(form.element, footer, result);
  return section;
}

export function mountHosts(host: HTMLElement, options: HostsMount = {}): { dispose(): void; refresh(): Promise<void> } {
  const request = requestFor(options);
  const root = el('section', 'hosts-settings');
  root.setAttribute('aria-label', 'SSH hosts');
  const head = el('div', 'hosts-head');
  const status = el('p', 'hosts-error');
  const authorizeHost = el('div', 'hosts-authorize-host');
  const list = el('div', 'hosts-list');
  const refreshButton = button('Refresh', 'Refresh hosts', () => void refresh(), 'small-button');
  const closeButton = button('Close', 'Close host settings', () => options.onClose?.(), 'small-button');
  head.append(el('h2', '', 'Hosts'), refreshButton, closeButton);
  const intro = el('p', 'hosts-note', 'Add machines for SSH deploys. Orbit uses the system OpenSSH client with its own config, one install key and verified first-use host keys. Agents never see keys, ssh config or tailcat addresses. Every command is audited.');
  const addSection = el('section', 'hosts-add');
  addSection.append(el('h3', '', 'Add a host'));
  const form = addForm({
    request,
    hosts: [],
    onAdded: (added, material) => {
      authorizeHost.replaceChildren();
      if (added) authorizeHost.append(authorizationPanel(added, material, request, () => void refresh()));
      else authorizeHost.append(el('p', 'hosts-ok', 'Host imported. Review the new card below, then test the connection.'));
    },
    onRefresh: () => void refresh(),
  });
  addSection.append(form.element, authorizeHost);
  root.append(head, intro, addSection, status, list);
  host.append(root);

  let disposed = false;
  let sequence = 0;
  async function refresh(): Promise<void> {
    const started = ++sequence;
    refreshButton.disabled = true;
    try {
      const data = await request({ action: 'list' });
      if (disposed || started !== sequence) return;
      const hosts = hostListOf(data);
      form.setHosts(hosts);
      list.replaceChildren();
      if (!hosts.length) {
        list.append(el('p', 'hosts-note', 'No hosts yet. Add one above to deploy infrastructure or a worker.'));
        return;
      }
      for (const item of hosts) list.append(card(item, request, () => void refresh()));
      status.textContent = '';
    } catch (error) {
      if (disposed || started !== sequence) return;
      status.textContent = errorText(error);
    } finally {
      if (!disposed && started === sequence) refreshButton.disabled = false;
    }
  }
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      root.remove();
    },
  };
}
