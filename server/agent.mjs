import fs from 'node:fs';
import { createSharedChats } from './shared-chats.mjs';
import { automation } from './automation.mjs';
import { tokenMatches, allowedRequest } from './security.mjs';
import { createBuildQueue } from './build-queue.mjs';
import { fileURLToPath } from 'node:url';

const sessionPattern = /^orbit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runPattern = /^run_[a-zA-Z0-9_-]{8,100}$/;
const instructions = 'You are Hermes, accessed through the owner’s Comet/Orbit Desktop agent chat. This is a separate conversation using your configured profile, tools and memory, not a continuation of another dashboard thread. Orbit terminal panes run as the owner on the host. Your agent tools still run in the configured Hermes environment. Use plain text in replies. Do not claim to see screen pixels, iframe contents, or terminal buffers unless supplied. Follow normal tool approval policies.';

export function createAgentHandler({ token, port, devOrigins, reply, workspaceContext, apiUrl = process.env.HERMES_API_URL, apiKey = process.env.HERMES_API_KEY, fetchImpl = fetch }) {
  async function upstream(path, body, method) {
    const r = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${path}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
    if (!r.ok) {
      const error = new Error(r.status === 429 ? 'Hermes is busy. Try again shortly.' : r.status === 404 ? 'This run is no longer available. Start a new message.' : r.status === 409 ? 'The run state changed. Refresh its status and try again.' : 'Hermes could not complete the request. Check the server connection.');
      error.status = [404, 409, 429].includes(r.status) ? r.status : 502;
      throw error;
    }
    return r.json();
  }
  let buildQueue;
  const shared = createSharedChats(fileURLToPath(new URL('../.runtime/shared-chats/', import.meta.url)));
  function validatePane(body) {
    const record = JSON.parse(fs.readFileSync(new URL(`../.runtime/workspaces/${body.workspace_id}.json`, import.meta.url), 'utf8'));
    const contains = layout => layout.type === 'pane' ? layout.pane.id === body.pane_id && layout.pane.kind === 'agent' : contains(layout.first) || contains(layout.second);
    if (!record.state.monitors.some(m => contains(m.layout))) throw Error('Chat pane is not open in this workspace');
  }
  return async function agent(req, res) {
    if (req.method !== 'POST' || !allowedRequest(req, port, devOrigins)) return reply(res, 403, { error: 'Origin rejected' });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), token)) return reply(res, 401, { error: 'Use Connect host with the Orbit session token first.' });
    if (!apiUrl || !apiKey) return reply(res, 503, { error: 'Hermes is not configured on this Orbit server.' });
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
      if (!body || typeof body !== 'object' || !sessionPattern.test(body.session_id || '')) return reply(res, 400, { error: 'Invalid Orbit conversation.' });
      if (body.pane_id) {
        if (!/^[a-f0-9-]{36}$/.test(body.workspace_id || '') || !/^[a-f0-9-]{36}$/.test(body.pane_id)) return reply(res,400,{error:'Invalid shared pane'});
        validatePane(body);
        if (body.action === 'shared_chat') {
          if(body.replace === true) {
            const current = shared.read(body.workspace_id,body.pane_id);
            if(current?.run || current?.session !== body.session_id || !sessionPattern.test(body.initial?.session || '')) return reply(res,409,{error:'Conversation changed or is still running.'});
            shared.write(body.workspace_id,body.pane_id,{session:body.initial.session,messages:(body.initial.messages || []).filter(m=>['user','assistant'].includes(m.role)&&typeof m.text==='string').slice(-100)});
          }
          const state = shared.bind(body.workspace_id,body.pane_id,body.initial);
          return reply(res,200,{state});
        }
        const linked = shared.read(body.workspace_id,body.pane_id);
        if (body.action === 'start' && !linked) return reply(res,409,{error:'This chat has not linked yet. Open it on the desktop and reload once.'});
        if (linked && linked.session !== body.session_id) return reply(res,409,{error:'This pane is linked to another conversation. Wait for synchronization.'});
      }
      if (body.action === 'build_queue') {
        buildQueue ||= createBuildQueue({ directory: fileURLToPath(new URL('../.runtime/build-queue/', import.meta.url)), upstream, context: workspaceContext });
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
        const abort = new AbortController(); res.on('close', () => abort.abort());
        const stream = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/v1/runs/${body.run_id}/events`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: abort.signal, redirect: 'error' });
        if (!stream.ok) return reply(res, 502, { error: 'Activity stream unavailable; use status polling.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        try { for await (const chunk of stream.body) { if (!res.write(chunk)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); }); if (res.destroyed) break; } } finally { abort.abort(); res.end(); }
        return;
      }
      if(body.action==='connection_password') {
        const paths = {chromium:'../.runtime/shared-browser/password.txt', xpra:'../.runtime/xpra/password'};
        if (!Object.hasOwn(paths, body.service)) return reply(res,400,{error:'Unknown connection.'});
        res.setHeader('Cache-Control','no-store');
        return reply(res,200,{password:fs.readFileSync(new URL(paths[body.service],import.meta.url),'utf8').trim()});
      }
      if(body.action==='shared_browser_connection') {
        const password=fs.readFileSync(new URL('../.runtime/shared-browser/password.txt',import.meta.url),'utf8').trim();
        return reply(res,200,{url:'https://kimi.tailec998.ts.net:4344/vnc.html?autoconnect=true&resize=scale',password});
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
        const lock = body.session_id;
        if(shared.locks.has(lock)) return reply(res,409,{error:'A message is already starting in this conversation.'});
        if(body.pane_id) {
          const current = shared.read(body.workspace_id,body.pane_id);
          if(current?.run) return reply(res,409,{error:'This conversation is already running on another device.'});
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
          const current = shared.read(body.workspace_id,body.pane_id) || {session:body.session_id,messages:[]};
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
        if(current?.run === body.run_id) shared.write(body.workspace_id,body.pane_id,{...current,run:undefined,messages:[...current.messages,{role:'assistant',text:run.output || `Run ${run.status}.`}].slice(-100)});
      }
      return reply(res, 200, { run_id: run.run_id, status: run.status, output: typeof run.output === 'string' ? run.output : '', error: run.error ? 'Hermes reported a run failure. Try again or check the Hermes dashboard.' : undefined, last_event: run.last_event, approvals });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      return reply(res, error.status || 502, { error: error.status ? error.message : 'Cannot reach Hermes right now. Your run may still be active; retry status before sending again.' });
    }
  };
}
