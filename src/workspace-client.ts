const mutations = new Set(['sync', 'apply', 'plugins_apply', 'restore', 'checkpoint', 'jev_apply']);

/** Send a workspace request while preserving the Response for callers' existing error handling. */
export async function workspaceFetch(token: string, body: Record<string, unknown>, endpoint = '/api/workspace'): Promise<Response> {
  const command = { ...body };
  if (mutations.has(String(command.action))) {
    if (command.action === 'checkpoint' && command.base_revision === undefined) {
      const current = await workspaceFetch(token, { workspace_id: command.workspace_id, action: 'read' }, endpoint);
      if (!current.ok) return current;
      command.base_revision = (await current.json()).revision;
    }
    if (command.base_revision === undefined) throw Error('Read the current workspace revision before changing it.');
    command.operation_id ??= crypto.randomUUID();
    command.intent ??= `Workspace ${command.action}`;
  }
  try {return await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(15000)
  });} catch {
    if(mutations.has(String(command.action)))throw Object.assign(Error(`Workspace mutation outcome unknown (operation ${command.operation_id}, base revision ${command.base_revision}). Read before reconsidering; reuse the exact key and payload for a retry.`),{operation_id:command.operation_id,base_revision:command.base_revision});
    throw Error('Workspace connection unavailable');
  }
}
