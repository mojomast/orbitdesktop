(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const tokenInput = byId('owner-token');
  const workspaceInput = byId('workspace-id');
  const connectButton = byId('connect');
  const readButton = byId('read-again');
  const restoreButton = byId('restore');
  const disableButton = byId('disable-apps');
  const enterHoldButton = byId('enter-hold');
  const releaseHoldButton = byId('release-hold');
  const restoreConfirm = byId('restore-confirm');
  const disableConfirm = byId('disable-confirm');
  const holdConfirm = byId('hold-confirm');
  const holdStatus = byId('hold-status');
  const holdGeneration = byId('hold-generation');
  const holdAvailability = byId('hold-availability');
  const checkpointList = byId('checkpoint-list');
  const pluginList = byId('plugin-list');
  const status = byId('status');
  const error = byId('error');
  const fields = {
    workspace_id: document.querySelector('[data-testid="meta-workspace-id"]'),
    revision: document.querySelector('[data-testid="meta-revision"]'),
    observed_revision: document.querySelector('[data-testid="meta-observed-revision"]'),
    browser_seen: document.querySelector('[data-testid="meta-browser-seen"]')
  };
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  let revision = null;
  let pluginCount = 0;
  let recoveryPolicy = null;
  let busy = false;
  let inputVersion = 0;

  function selectedCheckpoint() {
    return checkpointList.querySelector('input[name="checkpoint"]:checked');
  }

  function updateButtons() {
    connectButton.disabled = busy;
    readButton.disabled = busy;
    restoreButton.disabled = busy || revision === null || !selectedCheckpoint() || !restoreConfirm.checked;
    disableButton.disabled = busy || revision === null || pluginCount === 0 || !disableConfirm.checked;
    holdConfirm.disabled = busy || revision === null || recoveryPolicy === null;
    enterHoldButton.disabled = busy || revision === null || recoveryPolicy === null || recoveryPolicy.held || !holdConfirm.checked;
    releaseHoldButton.disabled = busy || revision === null || recoveryPolicy === null || !recoveryPolicy.held || !holdConfirm.checked;
  }

  function clearList(list) {
    while (list.firstChild) list.removeChild(list.firstChild);
  }

  function emptyList(list, message) {
    clearList(list);
    const item = document.createElement('li');
    item.textContent = message;
    list.appendChild(item);
  }

  function showMetadata(data) {
    fields.workspace_id.textContent = String(data.workspace_id);
    fields.revision.textContent = String(data.revision);
    fields.observed_revision.textContent = String(data.observed_revision);
    fields.browser_seen.textContent = data.browser_seen === null ? '—' : String(data.browser_seen);
    revision = data.revision;
    showRecoveryPolicy(data.recovery_policy);
    updateButtons();
  }

  function showRecoveryPolicy(policy) {
    recoveryPolicy = policy && typeof policy.held === 'boolean' && Number.isSafeInteger(policy.generation) && policy.generation >= 0 ? policy : null;
    holdStatus.textContent = recoveryPolicy === null ? 'Unavailable' : recoveryPolicy.held ? 'Held' : 'Released';
    holdGeneration.textContent = recoveryPolicy === null ? '—' : String(recoveryPolicy.generation);
    holdAvailability.textContent = recoveryPolicy === null
      ? 'This server did not provide a recovery policy. Hold controls are unavailable.'
      : 'Policy changes advance the workspace revision and policy generation.';
    holdConfirm.checked = false;
    updateButtons();
  }

  function showPlugins(plugins) {
    pluginCount = plugins.length;
    if (!pluginCount) {
      emptyList(pluginList, 'No registered apps.');
    } else {
      clearList(pluginList);
      for (const plugin of plugins) {
        const item = document.createElement('li');
        item.textContent = `${plugin.manifest.title} (${plugin.manifest.id}) — ${plugin.enabled ? 'enabled' : 'disabled'}`;
        pluginList.appendChild(item);
      }
    }
    updateButtons();
  }

  function showCheckpoints(checkpoints) {
    if (!checkpoints.length) {
      emptyList(checkpointList, 'No checkpoints available.');
    } else {
      clearList(checkpointList);
      for (const checkpoint of checkpoints) {
        const item = document.createElement('li');
        const label = document.createElement('label');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'checkpoint';
        radio.value = checkpoint.id;
        const description = document.createElement('span');
        description.textContent = ` ${checkpoint.label} — created ${new Date(checkpoint.created).toISOString()} — revision ${checkpoint.revision}`;
        label.appendChild(radio);
        label.appendChild(description);
        item.appendChild(label);
        checkpointList.appendChild(item);
      }
    }
    updateButtons();
  }

  function invalidate() {
    inputVersion++;
    revision = null;
    pluginCount = 0;
    showRecoveryPolicy(null);
    for (const field of Object.values(fields)) field.textContent = '—';
    emptyList(checkpointList, 'No checkpoints available.');
    emptyList(pluginList, 'No registered apps.');
    restoreConfirm.checked = false;
    disableConfirm.checked = false;
    status.textContent = '';
    updateButtons();
  }

  function credentials() {
    if (!tokenInput.value) {
      error.textContent = 'Enter the owner token.';
      return null;
    }
    if (!uuid.test(workspaceInput.value)) {
      error.textContent = 'Enter a valid workspace ID (UUID).';
      return null;
    }
    return workspaceInput.value;
  }

  async function request(body) {
    // The password input is the only persistent location of the owner token.
    const token = tokenInput.value;
    const mutation = ['sync', 'apply', 'plugins_apply', 'restore', 'checkpoint', 'jev_apply', 'recovery_policy'].includes(body.action);
    const command = mutation ? {
      ...body,
      operation_id: crypto.randomUUID(),
      intent: body.intent || (body.action === 'restore' ? 'Restore selected workspace checkpoint' : body.action === 'plugins_apply' ? 'Disable all workspace plugins' : `Workspace ${body.action}`)
    } : body;
    let response;
    let data;
    try {
      response = await fetch('/api/workspace/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(command)
      });
      data = await response.json();
    } catch {
      throw new Error('Could not reach the recovery endpoint.');
    }
    if (response.status === 409) throw new Error('Conflict: the workspace changed since this page loaded. Read again instead of retrying.');
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (status ${response.status})`);
    return data;
  }

  async function perform(work) {
    if (busy) return;
    busy = true;
    error.textContent = '';
    updateButtons();
    try {
      await work();
    } catch (failure) {
      error.textContent = failure.message;
      status.textContent = '';
      if (failure.message.startsWith('Conflict:')) {
        revision = null;
        holdConfirm.checked = false;
        restoreConfirm.checked = false;
        disableConfirm.checked = false;
      }
    } finally {
      busy = false;
      updateButtons();
    }
  }

  function readState() {
    if (busy) return;
    const workspaceId = credentials();
    if (!workspaceId) return;
    invalidate();
    const version = inputVersion;
    void perform(async () => {
      const current = await request({ workspace_id: workspaceId, action: 'read' });
      if (version !== inputVersion) return;
      showMetadata(current);
      showPlugins(current.state.plugins || []);
      const history = await request({ workspace_id: workspaceId, action: 'history' });
      if (version !== inputVersion) return;
      showCheckpoints(history.checkpoints);
      status.textContent = `Connected at revision ${current.revision}.`;
    });
  }

  connectButton.addEventListener('click', readState);
  readButton.addEventListener('click', readState);
  tokenInput.addEventListener('input', invalidate);
  workspaceInput.addEventListener('input', invalidate);
  checkpointList.addEventListener('change', updateButtons);
  restoreConfirm.addEventListener('change', updateButtons);
  disableConfirm.addEventListener('change', updateButtons);
  holdConfirm.addEventListener('change', updateButtons);

  function changeHold(held) {
    if (busy || revision === null || recoveryPolicy === null || recoveryPolicy.held === held || !holdConfirm.checked) return;
    const workspaceId = credentials();
    if (!workspaceId) return;
    const version = inputVersion;
    void perform(async () => {
      const result = await request({ workspace_id: workspaceId, action: 'recovery_policy', base_revision: revision, held, confirm: true, intent: held ? 'Enter registered-plugin recovery hold' : 'Release registered-plugin recovery hold' });
      if (version !== inputVersion) return;
      showMetadata(result);
      showPlugins(result.state.plugins || []);
      status.textContent = `${held ? 'Enter hold' : 'Release hold'} accepted at revision ${result.revision}, policy generation ${result.recovery_policy.generation}. Read the workspace state before claiming rendered behavior.`;
    });
  }

  enterHoldButton.addEventListener('click', () => changeHold(true));
  releaseHoldButton.addEventListener('click', () => changeHold(false));

  restoreButton.addEventListener('click', () => {
    const selected = selectedCheckpoint();
    if (busy || revision === null || !selected || !restoreConfirm.checked) return;
    const workspaceId = credentials();
    if (!workspaceId) return;
    const version = inputVersion;
    void perform(async () => {
      const result = await request({ workspace_id: workspaceId, action: 'restore', checkpoint_id: selected.value, base_revision: revision, confirm: true });
      if (version !== inputVersion) return;
      showMetadata(result);
      showPlugins(result.state.plugins || []);
      selected.checked = false;
      restoreConfirm.checked = false;
      status.textContent = `Restore accepted at revision ${result.revision}. Acknowledgement is not rendered proof; inspect the workspace before claiming success.`;
    });
  });

  disableButton.addEventListener('click', () => {
    if (busy || revision === null || pluginCount === 0 || !disableConfirm.checked) return;
    const workspaceId = credentials();
    if (!workspaceId) return;
    const version = inputVersion;
    void perform(async () => {
      const result = await request({ workspace_id: workspaceId, action: 'plugins_apply', base_revision: revision, operations: [{ action: 'plugin_disable_all' }] });
      if (version !== inputVersion) return;
      showMetadata(result);
      showPlugins(result.state.plugins || []);
      disableConfirm.checked = false;
      status.textContent = `Disable all apps accepted at revision ${result.revision}. Acknowledgement is not rendered proof; inspect the workspace before claiming success.`;
    });
  });

  updateButtons();
}());
