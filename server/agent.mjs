import { tokenMatches, allowedRequest } from './security.mjs';

const sessionPattern = /^orbit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runPattern = /^run_[a-zA-Z0-9_-]{8,100}$/;
const instructions = 'You are Hermes, accessed through the owner’s Orbit Desktop agent chat. This is a separate conversation using your configured profile, tools and memory, not a continuation of another dashboard thread. Orbit terminal panes run in a separate Docker container; your agent tools run in the Hermes environment, not inside that terminal container. Use plain text in replies. Do not claim to see the user’s screen or terminal contents unless supplied. Follow normal tool approval policies.';

export function createAgentHandler({ token, port, devOrigins, reply, apiUrl = process.env.HERMES_API_URL, apiKey = process.env.HERMES_API_KEY, fetchImpl = fetch }) {
  async function upstream(path, body) {
    const r = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
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
  return async function agent(req, res) {
    if (req.method !== 'POST' || !allowedRequest(req, port, devOrigins)) return reply(res, 403, { error: 'Origin rejected' });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), token)) return reply(res, 401, { error: 'Use Connect host with the Orbit session token first.' });
    if (!apiUrl || !apiKey) return reply(res, 503, { error: 'Hermes is not configured on this Orbit server.' });
    try {
      let raw = '', bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 32768) return reply(res, 413, { error: 'Message is too large.' });
        raw += part;
      }
      let body;
      try { body = JSON.parse(raw); } catch { return reply(res, 400, { error: 'Invalid JSON' }); }
      if (!body || typeof body !== 'object' || !sessionPattern.test(body.session_id || '')) return reply(res, 400, { error: 'Invalid Orbit conversation.' });
      if (body.action === 'start') {
        if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 8000) return reply(res, 400, { error: 'Enter a message of 1–8000 characters.' });
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
        const data = await upstream('/v1/runs', { input: body.input.trim(), session_id: body.session_id, instructions, conversation_history });
        return reply(res, 202, { run_id: data.run_id, status: data.status });
      }
      if (!['status', 'stop', 'approval'].includes(body.action) || !runPattern.test(body.run_id || '')) return reply(res, 400, { error: 'Invalid agent action.' });
      const path = `/v1/runs/${body.run_id}`;
      const run = await upstream(path);
      // Never let Orbit operate on another dashboard's sessions/runs.
      if (run.session_id !== body.session_id) return reply(res, 404, { error: 'Run not found in this Orbit conversation.' });
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
      return reply(res, 200, { run_id: run.run_id, status: run.status, output: typeof run.output === 'string' ? run.output : '', error: run.error ? 'Hermes reported a run failure. Try again or check the Hermes dashboard.' : undefined, last_event: run.last_event, approvals });
    } catch (error) {
      return reply(res, error.status || 502, { error: error.status ? error.message : 'Cannot reach Hermes right now. Your run may still be active; retry status before sending again.' });
    }
  };
}
