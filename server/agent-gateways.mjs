import { randomUUID } from 'node:crypto';
import { isGatewayProvider, providerLabel } from './agent-providers.mjs';

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
export function createAgentGateways({ fetchImpl = fetch, chats, grok, hermesProfile, gatewayProfile, grokProfile, now = () => Date.now() } = {}) {
  // One chat surface per gateway provider. A caller from the days of a single
  // Grok Bot gateway can still pass `grok` + `grokProfile` and gets the same map.
  const surfaces = chats instanceof Map ? chats : (grok ? new Map([['grok', grok]]) : new Map());
  const profileFor = typeof gatewayProfile === 'function'
    ? gatewayProfile
    : (typeof grokProfile === 'function' ? provider => (provider === 'grok' ? grokProfile() : null) : () => null);
  /** The chat surface for a gateway provider, with its bound profile. */
  const gatewayFor = provider => {
    const chat = isGatewayProvider(provider) ? surfaces.get(provider) : null;
    const profile = profileFor(provider);
    return chat && profile ? { chat, profile, name: providerLabel(provider) } : null;
  };
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
    const gateway = gatewayFor(speaker);
    if (!gateway) throw fail(`${providerLabel(speaker)} is not configured on this Orbit server.`, 409);
    const agentId = await gateway.chat.ensureSharedAgent(gateway.profile, grokAgentId, grokAgentName);
    const started = await gateway.chat.startSharedPrompt(gateway.profile, agentId, prompt);
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
    const gateway = gatewayFor(run.speaker);
    if (!gateway) return { status: 'failed', error: `${providerLabel(run.speaker)} is not configured on this Orbit server.` };
    return gateway.chat.pollSharedPrompt(gateway.profile, run);
  }

  async function stopSpeaker(run) {
    if (!run) return;
    if (run.speaker === 'hermes') {
      const profile = hermesProfile();
      if (profile && run.runId) await hermes(profile, `/v1/runs/${run.runId}/stop`, {});
      return;
    }
    const gateway = gatewayFor(run.speaker);
    if (gateway && run.agentId) await gateway.chat.stopSharedPrompt(gateway.profile, run.agentId);
  }

  async function tryDelegate(profile, body) {
    let response;
    try {
      response = await fetchImpl(`${profile.apiUrl.replace(/\/$/, '')}/v1/delegate_task`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
    } catch {
      return { exposed: false };
    }
    const text = typeof response?.text === 'function' ? await response.text() : '';
    try { await response?.body?.cancel?.(); } catch { /* the status is enough */ }
    if ([404, 405, 501].includes(response?.status)) return { exposed: false };
    if (!response?.ok) throw fail('Hermes could not start that subagent.', response?.status >= 500 ? 502 : (response?.status || 502));
    let data = null;
    try { data = text ? JSON.parse(text) : null; }
    catch { throw fail('Hermes returned invalid JSON.'); }
    if (!runPattern.test(data?.run_id || '')) throw fail('Hermes did not return a usable subagent run.');
    return { exposed: true, runId: data.run_id, sessionId: typeof data.session_id === 'string' ? data.session_id : '' };
  }

  async function startSubagent({ speaker, prompt, instructions, name, parentSession, hold = false }) {
    const label = String(name || 'worker').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (speaker === 'hermes') {
      const profile = hermesProfile();
      if (!profile?.apiUrl || !profile.apiKey) throw fail('Hermes is not configured on this Orbit server.', 409);
      if (!hold) {
        const delegated = await tryDelegate(profile, { session_id: parentSession || '', name: label, input: prompt, instructions });
        if (delegated.exposed) return { strategy: 'delegate_task', speaker, runId: delegated.runId, sessionId: delegated.sessionId || parentSession || '', started: now() };
      }
      const sessionId = `orbit-sub-${randomUUID()}`;
      if (hold) return { strategy: 'session', speaker, runId: '', sessionId, hold: true, started: now() };
      const data = await hermes(profile, '/v1/runs', { input: prompt, session_id: sessionId, instructions, conversation_history: [] });
      if (!runPattern.test(data?.run_id || '')) throw fail('Hermes did not return a usable subagent run.');
      return { strategy: 'session', speaker, runId: data.run_id, sessionId, started: now(), ...(tokenCount(data) ? { tokens: tokenCount(data) } : {}) };
    }
    const gateway = gatewayFor(speaker);
    if (!gateway) throw fail(`${providerLabel(speaker)} is not configured on this Orbit server.`, 409);
    const agentName = `Orbit collab sub: ${label}`.slice(0, 80);
    const agentId = await gateway.chat.ensureSharedAgent(gateway.profile, '', agentName);
    if (hold) return { strategy: 'agent', speaker, runId: '', agentId, hold: true, started: now() };
    const started = await gateway.chat.startSharedPrompt(gateway.profile, agentId, prompt);
    return { strategy: 'agent', speaker, runId: `run_${randomUUID().replaceAll('-', '')}`, agentId, started: started.started, nonce: started.nonce, baseline: started.baseline };
  }

  async function archiveSubagent(sub) {
    const gateway = sub?.agentId ? gatewayFor(sub.provider) : null;
    if (!gateway || typeof gateway.chat.archiveSharedAgent !== 'function') return { archived: false, note: `${providerLabel(sub?.provider)} archive is not available.` };
    return gateway.chat.archiveSharedAgent(gateway.profile, sub.agentId);
  }

  async function readSubagentTranscript(sub) {
    const gateway = sub?.agentId ? gatewayFor(sub.provider) : null;
    if (!gateway || typeof gateway.chat.previewSession !== 'function') return { messages: [] };
    const preview = await gateway.chat.previewSession(gateway.profile, sub.agentId);
    return { messages: preview?.messages || [] };
  }

  return { startSpeaker, pollSpeaker, stopSpeaker, startSubagent, archiveSubagent, readSubagentTranscript };
}
