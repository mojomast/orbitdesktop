import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createSharedChats } from './shared-chats.mjs';
import { createWorkbenchHermes } from './workbench-hermes.mjs';
import { automation } from './automation.mjs';
import { tokenMatches, allowedRequest } from './security.mjs';
import { createBuildQueue } from './build-queue.mjs';
import { createAgentProfiles, validSessionId, sanitizeSessions, sanitizeHistory } from './agent-profiles.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sessionPattern = /^orbit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runPattern = /^run_[a-zA-Z0-9_-]{8,100}$/;
const instructions = 'You are Hermes, accessed through the owner’s Comet/Orbit Desktop agent chat. This pane uses its explicitly selected profile and conversation, which may resume a saved Hermes session. Orbit terminal panes run as the owner on the host. Your agent tools still run in the configured Hermes environment. Use plain text in replies. Do not claim to see screen pixels, iframe contents, or terminal buffers unless supplied. Follow normal tool approval policies.';

export function createAgentHandler({ token, port, devOrigins, reply, workspaceContext, workspaceRead, runtimeDirectory = process.env.ORBIT_RUNTIME_DIR || fileURLToPath(new URL('../.runtime/', import.meta.url)), apiUrl = process.env.HERMES_API_URL, apiKey = process.env.HERMES_API_KEY, profiles, profilesJson = process.env.HERMES_PROFILES_JSON, fetchImpl = fetch, executionGate }) {
  let configuration;
  try { configuration = createAgentProfiles({profiles,profilesJson,apiUrl,apiKey}); } catch { configuration = null; }
  const endpoint = (profile, route) => `${profile.apiUrl.replace(/\/$/, '')}${route}`;
  // Bounded upstream JSON: read the real byte stream with a hard cap, cancel on
  // overflow, and decode as fatal UTF-8. There is no unbounded r.json() fallback;
  // a transport that does not expose a byte stream is refused.
  const MAX_UPSTREAM_JSON_BYTES = 2 * 1024 * 1024;
  async function readBoundedJson(response, maxBytes = MAX_UPSTREAM_JSON_BYTES) {
    const stream = response.body;
    if (!stream || typeof stream.getReader !== 'function') throw Object.assign(Error('Upstream response has no bounded byte stream'), { status: 502, upstreamStatus: 502 });
    const reader = stream.getReader();
    const chunks = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maxBytes) { try { await reader.cancel(); } catch {} throw Object.assign(Error('Upstream response exceeds the bounded JSON limit'), { status: 502, upstreamStatus: 502, code: 'limit_exceeded' }); }
        chunks.push(chunk);
      }
    } finally { try { reader.releaseLock(); } catch {} }
    const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw Object.assign(Error('Upstream response is not valid UTF-8'), { status: 502, upstreamStatus: 502 }); }
    try { return JSON.parse(text); } catch { throw Object.assign(Error('Upstream response is not valid JSON'), { status: 502, upstreamStatus: 502 }); }
  }
  async function upstreamFor(profile, route, body, method, headers = {}) {
    const r = await fetchImpl(endpoint(profile,route), {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...headers, Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
    if (!r.ok) {
      const error = new Error(r.status === 429 ? 'Hermes is busy. Try again shortly.' : r.status === 404 ? 'This run is no longer available. Start a new message.' : r.status === 409 ? 'The run state changed. Refresh its status and try again.' : 'Hermes could not complete the request. Check the server connection.');
      error.status = [404, 409, 429].includes(r.status) ? r.status : 502;
      error.ambiguous = r.status >= 500 || r.status === 408;
      error.upstreamStatus = r.status;
      throw error;
    }
    return readBoundedJson(r);
  }
  let buildQueue;
  const shared = createSharedChats(path.join(runtimeDirectory,'shared-chats'));
  function validatePane(body) {
    if(!workspaceRead)throw Object.assign(Error('Authoritative workspace access unavailable'),{status:503});
    let record;
    try {record=workspaceRead(body.workspace_id);}catch(error) {throw Object.assign(Error('Workspace unavailable'),{status:error.code==='ENOENT'?404:503});}
    const contains = layout => layout.type === 'pane' ? layout.pane.id === body.pane_id && layout.pane.kind === 'agent' : contains(layout.first) || contains(layout.second);
    if (!record.state.monitors.some(m => contains(m.layout))) throw Object.assign(Error('Chat pane is not open in this workspace'),{status:404});
  }
  const agent = async function agent(req, res) {
    if (req.method !== 'POST' || !allowedRequest(req, port, devOrigins)) return reply(res, 403, { error: 'Origin rejected' });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), token)) return reply(res, 401, { error: 'Use Connect host with the Orbit session token first.' });
    res.setHeader('Cache-Control','no-store');
    if (!configuration || !configuration.list.length) return reply(res, 503, { error: 'Hermes is not configured on this Orbit server.' });
    let paneLock;
    try {
      const chunks = []; let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 1048576) return reply(res, 413, { error: 'Message request exceeds 1 MiB.' });
        chunks.push(part);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = JSON.parse(raw); } catch { return reply(res, 400, { error: 'Invalid JSON' }); }
      if (!body || typeof body !== 'object') return reply(res,400,{error:'Invalid request.'});
      if (body.action === 'profiles') return reply(res,200,{profiles:configuration.list,default_profile_id:'default'});
      const profileId = body.profile_id === undefined ? 'default' : body.profile_id;
      const profile = configuration.get(profileId);
      // A removed profile must fail closed for execution, but the owner still
      // needs to read the binding and explicitly select a configured replacement.
      if (!profile && !['shared_chat','sessions','select_session'].includes(body.action)) return reply(res,400,{error:'Unknown Hermes profile.'});
      const upstream = (route, payload, method) => upstreamFor(profile,route,payload,method);
      if (!validSessionId(body.session_id) || (!body.pane_id && !sessionPattern.test(body.session_id))) return reply(res, 400, { error: 'Invalid Orbit conversation.' });
      if (body.pane_id) {
        if (!/^[a-f0-9-]{36}$/.test(body.workspace_id || '') || !/^[a-f0-9-]{36}$/.test(body.pane_id)) return reply(res,400,{error:'Invalid shared pane'});
        validatePane(body);
        if (['select_session', 'shared_chat', 'start'].includes(body.action) && agent.workbench.panePending(body)) return reply(res,409,{error:'A Workbench context submission is unresolved for this pane. Reconcile it before switching conversations.'});
        const candidateLock = `pane:${body.workspace_id}:${body.pane_id}`;
        if(shared.locks.has(candidateLock)) return reply(res,409,{error:'This pane is busy; retry shortly.'});
        paneLock = candidateLock;
        shared.locks.add(paneLock);
        if (body.action === 'sessions') {
          const target = configuration.get(body.target_profile_id);
          if (!target) return reply(res,400,{error:'Unknown Hermes profile.'});
          try { const data = await upstreamFor(target,'/api/sessions?limit=100&offset=0'); return reply(res,200,{sessions:sanitizeSessions(data).data,supported:true}); }
          catch(error) { if (error.status === 404) return reply(res,200,{sessions:[],supported:false,note:'Session catalog unavailable on this Hermes version.'}); throw error; }
        }
        if (body.action === 'shared_chat') {
          if(body.replace === true) return reply(res,409,{error:'Use validated session selection to change conversations.'});
          const state = shared.bind(body.workspace_id,body.pane_id,body.initial);
          return reply(res,200,{state});
        }
        const linked = shared.read(body.workspace_id,body.pane_id);
        if (!linked) return reply(res,409,{error:'This chat has not linked yet. Open it on the desktop and reload once.'});
        const revision = body.expected_binding_revision;
        if (body.action === 'select_session') {
          if (revision !== linked.binding_revision || linked.session !== body.session_id || linked.profile_id !== profileId || linked.run || shared.locks.has(`session:${linked.profile_id}:${linked.session}`)) return reply(res,409,{error:'Conversation changed or is still running.'});
          const target = configuration.get(body.target_profile_id);
          if (!target) return reply(res,400,{error:'Unknown Hermes profile.'});
          const creating = body.target_session_id === undefined || body.target_session_id === null;
          const targetId = creating ? `orbit-${randomUUID()}` : body.target_session_id;
          if (!validSessionId(targetId)) return reply(res,400,{error:'Invalid Hermes session.'});
          if (shared.locks.has(`session:${target.id}:${targetId}`) || shared.hasActive(target.id,targetId,body.workspace_id,body.pane_id)) return reply(res,409,{error:'This conversation is already running.'});
          let title;
          let messages=[];
          try { if (!creating) {
            const metadata = await upstreamFor(target,`/api/sessions/${encodeURIComponent(targetId)}`);
            if (metadata.id !== targetId) return reply(res,404,{error:'Hermes session not found.'});
            title = typeof metadata.title === 'string' ? metadata.title.slice(0,100) : undefined;
            const history = await upstreamFor(target,`/api/sessions/${encodeURIComponent(targetId)}/messages?limit=80&offset=0`);
            messages = sanitizeHistory(history);
          }
          } catch(error) { if (error.status === 404) return reply(res,404,{error:'Hermes session not found.'}); throw error; }
           const current = shared.read(body.workspace_id,body.pane_id);
           validatePane(body);
           if (shared.locks.has(`session:${target.id}:${targetId}`) || shared.hasActive(target.id,targetId,body.workspace_id,body.pane_id)) return reply(res,409,{error:'This conversation is already running.'});
           if (current.binding_revision !== revision || current.session !== body.session_id || current.profile_id !== profileId || current.run) return reply(res,409,{error:'Conversation changed or is still running.'});
          const state = shared.write(body.workspace_id,body.pane_id,{session:targetId,profile_id:target.id,binding_revision:revision+1,messages,title});
          return reply(res,200,{state});
        }
        if(linked.session !== body.session_id || linked.profile_id !== profileId || revision !== linked.binding_revision) return reply(res,409,{error:'This pane is linked to another conversation. Wait for synchronization.'});
      }
      if (body.action === 'build_queue') {
        if (profileId !== 'default') return reply(res,409,{error:'Build queue is only available for the default Hermes profile.'});
        buildQueue ||= createBuildQueue({ directory: path.join(runtimeDirectory,'build-queue'), upstream, context: workspaceContext, executionGate });
        try {
          if (body.operation === 'approvals') return reply(res, 200, { approvals: await buildQueue.approvals(body) });
          return reply(res, 200, await buildQueue.action(body));
        } catch (error) { return reply(res, 409, { error: error.message }); }
      }
      if (body.action === 'catalog') {
        if (!['skills', 'toolsets'].includes(body.kind)) return reply(res, 400, { error: 'Invalid catalog.' });
        const caps = await upstream('/v1/capabilities');
        if (!caps.endpoints?.[body.kind]) return reply(res, 409, { error: 'This gateway does not advertise this catalog.' });
        const data = await upstream(`/v1/${body.kind}`);
        const fields = body.kind === 'skills' ? ['name', 'description', 'category'] : ['name', 'label', 'description', 'enabled', 'configured', 'tools'];
        return reply(res, 200, { items: (Array.isArray(data.data) ? data.data : []).slice(0, 500).map(item => Object.fromEntries(fields.filter(k => item[k] !== undefined).map(k => [k, k === 'tools' ? (Array.isArray(item[k]) ? item[k].slice(0, 200).map(x => String(x).slice(0, 100)) : []) : typeof item[k] === 'boolean' ? item[k] : String(item[k]).slice(0, 2000)]))) });
      }
      if (body.action === 'capabilities') {
        const data = await upstream('/v1/capabilities');
        return reply(res, 200, { features: { run_events_sse: data.features?.run_events_sse === true } });
      }
      if (body.action === 'events') {
        if (!runPattern.test(body.run_id || '')) return reply(res, 400, { error: 'Invalid run.' });
        const run = await upstream(`/v1/runs/${body.run_id}`);
        if (run.session_id !== body.session_id) return reply(res, 404, { error: 'Run not found in this Orbit conversation.' });
        const caps = await upstream('/v1/capabilities');
        if (!caps.features?.run_events_sse) return reply(res, 409, { error: 'Streaming unavailable; use status polling.' });
        // Read-only streams must not starve status/stop/approval requests.
        if (paneLock) { shared.locks.delete(paneLock); paneLock = undefined; }
        const abort = new AbortController(); res.on('close', () => abort.abort());
        const stream = await fetchImpl(endpoint(profile,`/v1/runs/${body.run_id}/events`), { headers: { Authorization: `Bearer ${profile.apiKey}` }, signal: abort.signal, redirect: 'error' });
        if (!stream.ok) return reply(res, 502, { error: 'Activity stream unavailable; use status polling.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        try { for await (const chunk of stream.body) { if (!res.write(chunk)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); }); if (res.destroyed) break; } } finally { abort.abort(); res.end(); }
        return;
      }
      if(body.action==='connection_password') {
        const paths = {chromium:'shared-browser/password.txt', xpra:'xpra/password'};
        if (!Object.hasOwn(paths, body.service)) return reply(res,400,{error:'Unknown connection.'});
        res.setHeader('Cache-Control','no-store');
        return reply(res,200,{password:fs.readFileSync(path.join(runtimeDirectory,paths[body.service]),'utf8').trim()});
      }
      if(body.action==='shared_browser_connection') {
        const password=fs.readFileSync(path.join(runtimeDirectory,'shared-browser/password.txt'),'utf8').trim();
        res.setHeader('Cache-Control','no-store');
        return reply(res,200,{url:'/vnc.html?autoconnect=true&resize=scale',port:4344,password});
      }
      if(body.action==='automation') return reply(res,200,await automation(body,upstream));
      if (body.action === 'job_control') {
        if (!['pause', 'resume'].includes(body.operation) || typeof body.job_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.job_id) || body.confirm !== true) return reply(res, 400, { error: 'Confirm a valid pause or resume operation.' });
        await upstream(`/api/jobs/${encodeURIComponent(body.job_id)}/${body.operation}`, {});
        return reply(res, 200, { accepted: true, operation: body.operation });
      }
      if (body.action === 'jobs') {
        const data = await upstream('/api/jobs?include_disabled=true');
        const fields = ['id', 'name', 'enabled', 'state', 'schedule', 'schedule_display', 'next_run_at', 'last_run_at', 'last_status', 'paused'];
        const jobs = (Array.isArray(data.jobs) ? data.jobs : []).slice(0, 200).map(job => Object.fromEntries(fields.filter(k => job[k] !== undefined).map(k => [k, typeof job[k] === 'object' ? JSON.stringify(job[k]).slice(0, 1000) : typeof job[k] === 'string' ? job[k].slice(0, 1000) : job[k]])));
        return reply(res, 200, { jobs });
      }
      if (body.action === 'activity') {
        const data = await upstream(`/api/sessions/${body.session_id}/messages?limit=80&order=latest`);
        const activity = [];
        let budget = 80000;
        for (const m of (data.data || []).slice(-80)) {
          for (const call of (Array.isArray(m.tool_calls) ? m.tool_calls : []).slice(0, 100 - activity.length)) {
            const f = call.function || call;
            const detail = (typeof f.arguments === 'string' ? f.arguments : JSON.stringify(f.arguments || {})).slice(0, Math.min(4000, budget)); budget -= detail.length;
            activity.push({ kind: 'call', name: String(f.name || 'tool').slice(0, 100), id: String(call.id || '').slice(0, 150), detail });
          }
          if (m.role === 'tool') {
            const detail = String(m.content || '').slice(0, Math.min(8000, budget)); budget -= detail.length;
            activity.push({ kind: 'result', name: String(m.name || 'Tool result').slice(0, 100), id: String(m.tool_call_id || '').slice(0, 150), detail });
          }
          if (budget <= 0 || activity.length >= 100) break;
        }
        return reply(res, 200, { activity, note: 'Persisted tool history for this conversation; active tools may appear only after Hermes saves them. Results are truncated.' });
      }
      if (body.action === 'start') {
        if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 100000) return reply(res, 400, { error: 'Enter a message of 1–100,000 characters.' });
        // Do not start an ordinary run while the Workbench agent lane is held or
        // legacy-unknown. This never claims the lane and never stops an existing run.
        if (executionGate && typeof executionGate.busy === 'function' && executionGate.busy('agent')) return reply(res, 409, { error: 'The Workbench agent lane is busy or unresolved. Reconcile it before starting a new chat turn.' });
        const lock = `session:${profileId}:${body.session_id}`;
        if(shared.locks.has(lock)) return reply(res,409,{error:'A message is already starting in this conversation.'});
        if(body.pane_id) {
          const current = shared.read(body.workspace_id,body.pane_id);
          if(current?.run) return reply(res,409,{error:'This conversation is already running on another device.'});
          if(shared.hasActive(profileId,body.session_id,body.workspace_id,body.pane_id)) return reply(res,409,{error:'This conversation is already running in another pane.'});
        }
        shared.locks.add(lock);
        try {
        // Older Hermes Runs implementations persist sessions but do not reload
        // their transcripts automatically. Supply bounded conversational history
        // from the authenticated session API (never from untrusted client roles).
        let conversation_history = [];
        try {
          const transcript = await upstream(`/api/sessions/${body.session_id}/messages`);
          const rows = (transcript.data || []).filter(m => ['user', 'assistant'].includes(m.role) && !m.tool_calls?.length && typeof m.content === 'string' && m.content.trim());
          let size = 0;
          for (const m of rows.slice(-80).reverse()) {
            const content = m.content.slice(0, 16000);
            if (size + content.length > 120000) break;
            conversation_history.unshift({ role: m.role, content });
            size += content.length;
          }
          while (conversation_history.length && conversation_history[0].role !== 'user') conversation_history.shift();
        } catch (error) { if (error.status !== 404) throw error; }
        let context = '';
        if (body.workspace_id && workspaceContext) {
          try { context = workspaceContext(body.workspace_id); }
          catch { return reply(res, 409, { error: 'Workspace has not synced yet. Wait for workspace connection and retry.' }); }
        }
        const data = await upstream('/v1/runs', { input: body.input.trim(), session_id: body.session_id, instructions: instructions + context, conversation_history });
        if(body.pane_id) {
           const current = shared.read(body.workspace_id,body.pane_id);
          shared.write(body.workspace_id,body.pane_id,{...current,run:data.run_id,messages:[...current.messages,{role:'user',text:body.input.trim()}].slice(-100)});
        }
        return reply(res, 202, { run_id: data.run_id, status: data.status });
        } finally {shared.locks.delete(lock);}
      }
      if (!['status', 'stop', 'approval', 'steer'].includes(body.action) || !runPattern.test(body.run_id || '')) return reply(res, 400, { error: 'Invalid agent action.' });
      const path = `/v1/runs/${body.run_id}`;
      const run = await upstream(path);
      // Never let Orbit operate on another dashboard's sessions/runs.
      if (run.session_id !== body.session_id) return reply(res, 404, { error: 'Run not found in this Orbit conversation.' });
      if (body.action === 'steer') {
        if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 100000) return reply(res, 400, { error: 'Guidance must contain 1–100,000 characters.' });
        const data = await upstream(`${path}/steer`, { input: body.input.trim() });
        return reply(res, 200, { accepted: data.accepted === true });
      }
      if (body.action === 'stop') {
        await upstream(`${path}/stop`, {});
        return reply(res, 200, { status: 'stopping' });
      }
      if (body.action === 'approval') {
        if (!['once', 'deny'].includes(body.choice)) return reply(res, 400, { error: 'Only allow-once or deny is supported.' });
        const data = await upstream(`${path}/approval`, { choice: body.choice });
        return reply(res, 200, { status: 'running', resolved: data.resolved });
      }
      let approvals = [];
      if (run.status === 'waiting_for_approval') {
        const pending = await upstream(`/v1/approvals/pending?session_id=${encodeURIComponent(body.run_id)}`);
        approvals = (pending.approvals || []).map(a => ({ command: String(a.command || a.description || a.tool_name || 'Tool execution requires approval').slice(0, 4000), reason: String(a.reason || '').slice(0, 1000) }));
      }
      if(body.pane_id && ['completed','failed','cancelled','interrupted'].includes(run.status)) {
        const current = shared.read(body.workspace_id,body.pane_id);
        if(current?.run === body.run_id && current.session === body.session_id && current.profile_id === profileId) shared.write(body.workspace_id,body.pane_id,{...current,run:undefined,messages:[...current.messages,{role:'assistant',text:run.output || `Run ${run.status}.`}].slice(-100)});
      }
      return reply(res, 200, { run_id: run.run_id, status: run.status, output: typeof run.output === 'string' ? run.output : '', error: run.error ? 'Hermes reported a run failure. Try again or check the Hermes dashboard.' : undefined, last_event: run.last_event, approvals });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      return reply(res, error.status || 502, { error: error.status ? error.message : 'Cannot reach Hermes right now. Your run may still be active; retry status before sending again.' });
    } finally {
      if(paneLock) shared.locks.delete(paneLock);
    }
  };
  agent.workbench = createWorkbenchHermes({ configuration, shared, locks: shared.locks, upstreamFor, validatePane, workspaceRead, runtimeDirectory });
  return agent;
}
