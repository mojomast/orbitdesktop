import { randomUUID } from 'node:crypto';

const runPattern = /^run_[a-zA-Z0-9_-]{8,100}$/;

function fail(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function tokenCount(run) {
  const value = Number(run?.usage?.total_tokens ?? run?.usage?.totalTokens ?? run?.total_tokens);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Hermes and Grok Bot calls shared by the shared room and Collab.
 * Callers own transcripts, budgets and task state.
 */
export function createAgentGateways({ fetchImpl = fetch, grok, hermesProfile, grokProfile, now = () => Date.now() } = {}) {
  async function hermes(profile, route, body) {
    let response;
    try {
      response = await fetchImpl(`${profile.apiUrl.replace(/\/$/, '')}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
      const text = typeof response?.text === 'function' ? await response.text() : '';
      if (!response || response.ok !== true) throw fail(response?.status === 404 ? 'Hermes can no longer find that run.' : 'Hermes could not complete the shared turn.', response?.status >= 500 ? 502 : (response?.status || 502));
      if (!text) return null;
      try { return JSON.parse(text); }
      catch { throw fail('Hermes returned invalid JSON.'); }
    } catch (error) {
      try { await response?.body?.cancel?.(); } catch {}
      if (error?.status) throw error;
      throw fail('Cannot reach Hermes right now.');
    }
  }

  function hermesView(run) {
    const status = run?.status;
    if (status === 'waiting_for_approval') return { status, error: 'Hermes is waiting for a tool approval. Resolve it in the Hermes chat, or cancel the delegated task.' };
    if (status === 'completed') return { status, output: String(run.output || 'Hermes finished without a text reply.').slice(0, 16000) };
    if (['failed', 'cancelled', 'interrupted'].includes(status)) return { status: 'failed', error: status === 'failed' ? 'Hermes reported a failure.' : `Hermes ${status} this turn.` };
    return { status: 'running' };
  }

  async function startSpeaker({ speaker, prompt, instructions, hermesSession, grokAgentId, grokAgentName }) {
    if (speaker === 'hermes') {
      const profile = hermesProfile();
      if (!profile?.apiUrl || !profile.apiKey) throw fail('Hermes is not configured on this Orbit server.', 409);
      const data = await hermes(profile, '/v1/runs', { input: prompt, session_id: hermesSession, instructions, conversation_history: [] });
      if (!runPattern.test(data?.run_id || '')) throw fail('Hermes did not return a usable run.');
      const tokens = tokenCount(data);
      return { runId: data.run_id, started: now(), ...(tokens ? { tokens } : {}) };
    }
    const profile = grokProfile();
    if (!profile?.apiUrl || !profile.apiKey) throw fail('Grok Bot is not configured on this Orbit server.', 409);
    const agentId = await grok.ensureSharedAgent(profile, grokAgentId, grokAgentName);
    const started = await grok.startSharedPrompt(profile, agentId, prompt);
    return { runId: `run_${randomUUID().replaceAll('-', '')}`, started: started.started, nonce: started.nonce, baseline: started.baseline, agentId };
  }

  async function pollSpeaker(run) {
    if (!run) return { status: 'idle' };
    if (run.speaker === 'hermes') {
      const profile = hermesProfile();
      if (!profile) return { status: 'failed', error: 'Hermes is not configured on this Orbit server.' };
      const raw = await hermes(profile, `/v1/runs/${run.runId}`);
      const view = hermesView(raw);
      const tokens = tokenCount(raw);
      if (tokens) view.tokens = tokens;
      return view;
    }
    const profile = grokProfile();
    if (!profile) return { status: 'failed', error: 'Grok Bot is not configured on this Orbit server.' };
    return grok.pollSharedPrompt(profile, run);
  }

  async function stopSpeaker(run) {
    if (!run) return;
    if (run.speaker === 'hermes') {
      const profile = hermesProfile();
      if (profile) await hermes(profile, `/v1/runs/${run.runId}/stop`, {});
      return;
    }
    const profile = grokProfile();
    if (profile && run.agentId) await grok.stopSharedPrompt(profile, run.agentId);
  }

  return { startSpeaker, pollSpeaker, stopSpeaker };
}
