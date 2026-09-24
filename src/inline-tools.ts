import { el, button } from './dom';
import './inline-tools.css';

// Trusted chat only. Never forward these details to sandboxed plugins or persist them.
export function createInlineTools(pane: string, scroller: HTMLElement, activity?: () => Promise<{activity?: {kind:string; name:string; id:string; detail:string}[]}>) {
  const key = `orbit-inline-tools:${pane}`;
  let enabled = false, session = '', run = '', sequence = 0;
  try { enabled = localStorage.getItem(key) === 'on'; } catch {}
  const root = el('section', 'inline-tools');
  root.setAttribute('aria-label', 'Inline tool activity');
  const note = el('div', 'inline-tools-note', 'Waiting for tool events. Details may contain private data.');
  const rows = el('div', 'inline-tools-rows');
  const totals = el('div','inline-tools-totals');
  const compact = button('Hide completed','Collapse successful calls; keep failures and running calls visible',()=>{
    rows.classList.toggle('hide-completed');
    compact.textContent=rows.classList.contains('hide-completed')?'Show completed':'Hide completed';
    compact.setAttribute('aria-pressed',String(rows.classList.contains('hide-completed')));
  });
  const follow = button('Jump to latest', 'Resume following live tool calls', () => { scroller.scrollTop = scroller.scrollHeight; });
  root.append(note, totals, compact, follow, rows);
  const saved = el('details', 'inline-tools-saved'); saved.append(el('summary', '', 'Saved conversation tool history'));
  const history = el('div'); saved.append(history);
  let disposed = false;
  if (activity) root.append(button('Load saved details', 'Load persisted tool arguments and results for this conversation', async () => {
    const requestedSession = session;
    try {
      const data = await activity();
      if(disposed || requestedSession !== session) return;
      history.replaceChildren();
      for(const item of data.activity || []) {
        const row = el('details');
        row.append(el('summary', '', `${item.kind === 'call' ? 'Arguments' : 'Result'} · ${item.name}`), el('small', '', item.id ? `Call ${item.id}` : 'No call ID supplied'), el('pre', '', item.detail));
        history.append(row);
      }
      if(!history.childElementCount) history.textContent = 'No persisted tools yet. Active calls may appear only after Hermes saves them.';
      saved.open = true;
    } catch { if(!disposed && requestedSession === session) { history.textContent = 'Saved activity unavailable. Connect host and try again.'; saved.open = true; } }
  }), saved);
  const toggle = button('Show tools', 'Show inline tool calls and details', () => {
    enabled = !enabled;
    try { localStorage.setItem(key, enabled ? 'on' : 'off'); } catch {}
    updateToggle();
  }, 'small-button');
  function updateToggle() { root.hidden = !enabled; toggle.textContent = enabled ? 'Hide tools' : 'Show tools'; toggle.setAttribute('aria-pressed', String(enabled)); }
  updateToggle();
  type Row = { node: HTMLDetailsElement; summary: HTMLElement; detail: HTMLElement; name: string; started: number; phase: string; duration?: number; preview: string };
  const calls = new Map<string, Row>();
  function summary() {
    const all=[...calls.values()], running=all.filter(r=>r.phase==='Running');
    const completed=all.filter(r=>r.phase==='Completed'),failed=all.filter(r=>r.phase==='Failed');
    const grouped=new Map<string,number>();
    for(const r of completed) grouped.set(r.name,(grouped.get(r.name)||0)+1);
    totals.textContent=`${running.length} running · ${completed.length} completed · ${failed.length} failed` + (grouped.size ? ' · '+[...grouped].map(([name,count])=>`${name} ×${count}`).join(', ') : '');
    return running.length ? `Running ${running[0].name}${running.length>1 ? ` +${running.length-1}` : ''}` : failed.length ? 'Tool failure observed · agent may continue' : 'Working · awaiting next event';
  }
  const seen = new Set<string>();
  const text = (v: unknown): string => v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v, null, 2)).slice(0, 12000);
  function label(row: Row) {
    const elapsed = row.duration ?? (row.phase === 'Running' ? Math.max(0, Date.now()/1000-row.started) : undefined);
    row.summary.textContent = `${row.phase} · ${row.name}${elapsed === undefined ? '' : ` · ${elapsed.toFixed(1)}s`}${row.preview ? ` · ${row.preview.slice(0, 140).replace(/\s+/g, ' ')}` : ''}`;
    row.node.dataset.phase = row.phase;
  }
  function event(raw: Record<string, unknown>, runId: string) {
    const kind = String(raw.event || raw.type || '');
    if (!/^tool[._]/.test(kind)) return;
    if (run !== runId) { run = runId; calls.clear(); seen.clear(); rows.replaceChildren(); }
    const fingerprint = JSON.stringify(raw);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint); if(seen.size > 600) seen.delete(seen.values().next().value!);
    const pinned = scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight < 70;
    const id = text(raw.tool_call_id || raw.toolCallId || raw.call_id || raw.callId);
    // Without a canonical ID, keep separate observations rather than merge concurrent calls by name.
    const identity = id || `observation-${++sequence}`;
    const name = text(raw.tool || raw.tool_name || raw.name || 'Tool').slice(0, 100);
    let row = calls.get(identity);
    if (!row) {
      const node = el('details', 'inline-tool'); const summary = el('summary'); const detail = el('div', 'inline-tool-detail');
      node.append(summary, detail); rows.append(node);
      const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.now()/1000;
      row = { node, summary, detail, name, started: timestamp > 1e12 ? timestamp/1000 : timestamp, phase: 'Observed', preview: '' };
      calls.set(identity, row);
      if (id) detail.append(el('small', '', `Call ${id}`));
      else detail.append(el('small', '', 'No call ID supplied · standalone event'));
      while(calls.size > 100) { const oldest = calls.keys().next().value!; calls.get(oldest)!.node.remove(); calls.delete(oldest); }
    }
    if (/start|call$/.test(kind)) row.phase = id ? 'Running' : 'Started · uncorrelated';
    if (/complet|output|result/.test(kind)) row.phase = 'Completed';
    if (/fail|error/.test(kind) || raw.error === true) row.phase = 'Failed';
    if (typeof raw.duration === 'number' && Number.isFinite(raw.duration)) row.duration = Math.max(0, raw.duration);
    const preview = text(raw.preview || raw.message);
    if (preview) row.preview = preview;
    const payload = raw.arguments ?? raw.args ?? raw.output ?? raw.result ?? raw.preview ?? raw.message;
    if (payload !== undefined) {
      const detail = el('details'); detail.append(el('summary', '', kind), el('pre', '', text(payload))); row.detail.append(detail);
      while(row.detail.childElementCount > 12) row.detail.children[1]?.remove();
    }
    label(row); summary(); note.textContent = 'Live tool activity · expand a row for details (up to 12,000 characters).';
    if (pinned && enabled) scroller.scrollTop = scroller.scrollHeight;
  }
  const timer = setInterval(() => { for(const row of calls.values()) if(row.phase === 'Running') label(row); }, 1000);
  return { root, toggle, enabled: () => enabled, event, summary,
    show: () => { if(!enabled) toggle.click(); root.scrollIntoView({block:'nearest'}); },
    status: (value: string) => { note.textContent = value; },
    sync: (sessionId: string, activeRun?: string) => {
      if(session !== sessionId || (activeRun && run && activeRun !== run)) { calls.clear(); seen.clear(); rows.replaceChildren(); history.replaceChildren(); saved.open = false; run = ''; note.textContent = 'Waiting for tool events. Details may contain private data.'; }
      session = sessionId;
      if(!activeRun) for(const row of calls.values()) if(row.phase === 'Running') {row.phase = 'Ended · result not observed'; label(row);}
      summary();
    },
    dispose: () => { disposed = true; clearInterval(timer); },
  };
}
