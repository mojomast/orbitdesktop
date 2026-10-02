import { el, button } from './dom';
import { extractInteractiveResult } from './interactive-result-adapter';

/** Only trusted callers with a complete authenticated result may mount these actions. */
export function completeResultActions(text: string, source: { id: string; version: string }, current: () => boolean) {
  const host = el('div', 'complete-result-actions');
  const interactive = extractInteractiveResult(text);
  if (interactive.status === 'unavailable' && (/```a2ui\b/.test(text) || /^\s*\{\s*"a2ui"\s*:/.test(text)))
    host.append(el('p', '', `Interactive result unavailable: ${interactive.reason}`));
  if (interactive.status === 'ok') host.append(button('Open interactive result', 'Choose a results pane for this complete reply', async () => {
    const adapter = await import('./interactive-result-host');
    if (!current()) return;
    choose(adapter.interactiveResultTargets(), target => adapter.queueInteractiveResult(text, source, { ...target, onAcknowledgement: ack => {
      if (current()) host.append(el('p', '', `Delivery ${ack.deliveryId}: ${ack.status} in pane ${ack.paneId} (generation ${ack.generation}). Saving remains explicit.`));
    } }));
  }));
  // An explicit sole-key envelope keeps ordinary prose and HTML out of the adapter.
  let snapshot: unknown;
  try { const value = JSON.parse(text); if (Object.keys(value).length === 1 && Object.hasOwn(value, 'mcp_snapshot')) snapshot = value.mcp_snapshot; } catch {}
  if (snapshot) host.append(button('Stage MCP snapshot', 'Choose an MCP Apps pane; import and execution stay explicit', async () => {
    const adapter = await import('./mcp-apps-host');
    if (!current()) return;
    choose(adapter.mcpSnapshotTargets(), target => adapter.stageMcpSnapshot(snapshot, source, target));
  }));
  function choose(targets: { paneId: string; generation: string }[], deliver: (target: { paneId: string; generation: string }) => { status: string; reason?: string; deliveryId?: string }) {
    const dialog = el('dialog', 'hermes-tools-dialog'); dialog.setAttribute('aria-label', 'Choose result recipient');
    dialog.append(el('h2', '', 'Choose one result recipient'));
    if (!targets.length) dialog.append(el('p', '', 'Open the corresponding surface from Start, then try again.'));
    for (const target of targets) dialog.append(button(`Pane ${target.paneId}`, 'Deliver to this pane', () => {
      if (!current()) { dialog.close(); return; }
      const result = deliver(target);
      if (result.status === 'unavailable') dialog.append(el('p', '', result.reason));
      else { host.append(el('p', '', `${result.status}: ${result.deliveryId ?? ''}. Review in the selected pane. Not yet saved.`)); dialog.close(); }
    }));
    dialog.append(button('Cancel', 'Cancel result delivery', () => dialog.close()));
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  }
  return host;
}
