const el = id => document.getElementById(id);
let owner = '', generation = 0, busy = false, hideTimer;
function hide() { clearTimeout(hideTimer); el('payload').textContent = ''; el('hide').hidden = true; }
function lock() {
  generation++; owner = ''; el('token').value = ''; hide();
  el('workers').replaceChildren(); el('tasks').replaceChildren(); el('briefs').replaceChildren(); el('panel').hidden = true; el('unlock').hidden = false;
  el('status').textContent = '';
}
async function post(body) {
  const r = await fetch('/api/local-workers', { method:'POST', headers:{ 'Content-Type':'application/json',Authorization:`Bearer ${owner}` },
    body:JSON.stringify(body), cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer', redirect:'error' });
  const data = await r.json();
  if (!r.ok || data.protocol !== 'orbit.worker-join/1') throw Error(r.status === 403 ? 'Owner authorization or loopback origin refused.' : 'Join operation unavailable. Check join-only mode and refresh inventory.');
  return data;
}
function act(fn) {
  return async event => {
    event?.preventDefault(); if (busy) return; busy = true; const stamp = generation;
    try { await fn(stamp); } catch (err) { if (generation === stamp) el('status').textContent = err.message; }
    finally { busy = false; }
  };
}
function button(row, text, body) {
  const control = document.createElement('button'); control.textContent = text;
  control.onclick = act(async stamp => { await post(body); if (stamp === generation) { hide(); await refresh(stamp); } });
  row.append(' ',control);
}
async function refresh(stamp) {
  const { workers,tasks,briefs } = await post({ op:'inventory' });
  if (stamp !== generation) return;
  el('panel').hidden = false; el('unlock').hidden = true;
  el('workers').replaceChildren(); el('tasks').replaceChildren();
  el('briefs').replaceChildren();
  for (const b of briefs) { const row=document.createElement('li');row.textContent=`${b.attemptId} · ${b.workerId} — ${b.state}${b.waveCommit ? ' · '+b.waveCommit : ''}`;el('briefs').append(row); }
  for (const w of workers) {
    const row = document.createElement('li');
    const lastSeen = w.lastSeen ? new Date(w.lastSeen).toISOString() : 'never';
    row.textContent = `${w.label} (${w.workerId}) — ${w.state}; grants: ${w.scopes.join(', ')}; last contact: ${lastSeen}`;
    if (w.state !== 'revoked') button(row,'Revoke',{ op:'revoke',workerId:w.workerId });
    if (w.state === 'paired' && w.scopes.includes('verify-client') && !tasks.some(t => t.workerId === w.workerId && ['queued','claimed','reported'].includes(t.state))) button(row,'Request digest',{ op:'queue-verification',workerId:w.workerId });
    el('workers').append(row);
  }
  for (const t of tasks) {
    const row = document.createElement('li'); row.textContent = `${t.taskId} · ${t.workerId} — ${t.state}`;
    if (t.state === 'reported') button(row,'Compare with pin',{ op:'review-verification',taskId:t.taskId });
    el('tasks').append(row);
  }
  el('status').textContent = `${workers.length} worker(s), ${tasks.length} check(s).`;
}
el('unlock').onsubmit = act(async stamp => {
  owner = el('token').value; el('token').value = '';
  try { await refresh(stamp); } catch (err) { owner = ''; throw err; }
});
el('lock').onclick = lock; el('hide').onclick = hide; el('reload').onclick = act(refresh);
el('invite').onsubmit = act(async stamp => {
  hide(); const scopes = el('verify').checked ? ['presence','verify-client'] : ['presence'];
  if(el('sum').checked)scopes.push('sum-brief');
  const grant = await post({ op:'invite',label:el('label').value,scopes });
  if (generation !== stamp) return;
  el('payload').textContent = JSON.stringify(grant); el('hide').hidden = false;
  hideTimer = setTimeout(hide,Math.max(0,grant.expiresAt - Date.now())); await refresh(stamp);
});
window.addEventListener('pagehide',lock);
if (window.top !== window.self || !['127.0.0.1','[::1]'].includes(location.hostname)) {
  el('unlock').hidden = true; el('token').disabled = true;
  el('status').textContent = 'Open the inventory directly at the numeric loopback origin of your test instance.';
}
