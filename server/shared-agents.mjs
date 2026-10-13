import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const runPattern = /^run_[a-zA-Z0-9_-]{8,100}$/;
const speakers = ['hermes', 'grok'];
const labels = { owner: 'Owner', hermes: 'Hermes', grok: 'Grok Bot', note: 'Orbit' };

function fail(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function other(speaker) {
  return speaker === 'hermes' ? 'grok' : 'hermes';
}

function paneKey(body) {
  if (!/^[a-f0-9-]{36}$/.test(body.workspace_id || '') || !/^[a-f0-9-]{36}$/.test(body.pane_id || '')) throw fail('Open shared agents from an agent pane.', 400);
  return `${body.workspace_id}.${body.pane_id}`;
}

function blank(key) {
  return {
    key,
    messages: [],
    next: 'hermes',
    auto: false,
    maxTurns: 4,
    turns: 0,
    paused: false,
    activity: '',
    hermesSession: `orbit-${randomUUID()}`,
    grokAgentId: '',
    run: null,
  };
}

function promptFor(speaker, messages) {
  const name = labels[speaker];
  const partner = labels[other(speaker)];
  const lines = messages.filter(message => message.speaker !== 'note').slice(-30).map(message => `${labels[message.speaker] || 'Orbit'}: ${message.text}`).join('\n\n');
  const transcript = lines.slice(-12000);
  return `You are ${name}, speaking in a shared Orbit conversation with the owner and ${partner}. Reply only as ${name}. Do not write lines for the owner or ${partner}. Use plain text.\n\nRecent transcript:\n${transcript || '(no messages yet)'}\n\nReply to the latest message.`;
}

function publicState(state) {
  return {
    messages: state.messages.map(message => ({ id: message.id, speaker: message.speaker, text: message.text, at: message.at, ...(message.error ? { error: true } : {}) })),
    next: state.next,
    auto: state.auto,
    max_turns: state.maxTurns,
    turns: state.turns,
    paused: state.paused,
    running: state.run?.speaker || '',
    activity: state.activity || '',
  };
}

export function createSharedAgents({ directory, fetchImpl = fetch, grok, hermesProfile, grokProfile, now = () => Date.now() }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const chains = new Map();

  function fileFor(key) {
    return path.join(directory, `${key}.json`);
  }

  function load(key) {
    try {
      const record = JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
      if (!record || !Array.isArray(record.messages) || !speakers.includes(record.next)) return blank(key);
      record.key = key;
      record.messages = record.messages.filter(message => message && labels[message.speaker] && typeof message.text === 'string').slice(-200);
      record.auto = record.auto === true;
      record.maxTurns = Number.isInteger(record.maxTurns) && record.maxTurns >= 1 && record.maxTurns <= 8 ? record.maxTurns : 4;
      record.turns = Number.isInteger(record.turns) && record.turns >= 0 ? record.turns : 0;
      record.paused = record.paused === true;
      record.activity = typeof record.activity === 'string' ? record.activity.slice(0, 300) : '';
      record.hermesSession = /^orbit-[0-9a-f-]{36}$/.test(record.hermesSession || '') ? record.hermesSession : `orbit-${randomUUID()}`;
      record.grokAgentId = typeof record.grokAgentId === 'string' ? record.grokAgentId : '';
      record.run = record.run && speakers.includes(record.run.speaker) && typeof record.run.runId === 'string' ? record.run : null;
      return record;
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('The shared transcript could not be read.');
      return blank(key);
    }
  }

  function save(state) {
    const dest = fileFor(state.key);
    const temp = `${dest}.${process.pid}.tmp`;
    const record = {
      messages: state.messages.slice(-200),
      next: state.next,
      auto: state.auto,
      maxTurns: state.maxTurns,
      turns: state.turns,
      paused: state.paused,
      activity: state.activity || '',
      hermesSession: state.hermesSession,
      grokAgentId: state.grokAgentId || '',
      run: state.run,
    };
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, dest);
  }

  function append(state, speaker, text, error = false) {
    const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 16000);
    if (!clean) return;
    state.messages.push({ id: `m_${randomUUID().replaceAll('-', '')}`, speaker, text: clean, at: new Date(now()).toISOString(), ...(error ? { error: true } : {}) });
    state.messages = state.messages.slice(-200);
  }

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
    if (status === 'waiting_for_approval') return { status, error: 'Hermes is waiting for a tool approval. Stop this turn or resolve it in the Hermes chat.' };
    if (status === 'completed') return { status, output: String(run.output || 'Hermes finished without a text reply.').slice(0, 16000) };
    if (['failed', 'cancelled', 'interrupted'].includes(status)) return { status: 'failed', error: status === 'failed' ? 'Hermes reported a failure.' : `Hermes ${status} this turn.` };
    return { status: 'running' };
  }

  async function begin(state, speaker) {
    const prompt = promptFor(speaker, state.messages);
    try {
      if (speaker === 'hermes') {
        const profile = hermesProfile();
        if (!profile?.apiUrl || !profile.apiKey) throw fail('Hermes is not configured on this Orbit server.', 409);
        const data = await hermes(profile, '/v1/runs', { input: prompt, session_id: state.hermesSession, instructions: 'You are Hermes in a shared Orbit conversation with the owner and Grok Bot. Reply only as Hermes.', conversation_history: [] });
        if (!runPattern.test(data?.run_id || '')) throw fail('Hermes did not return a usable run.');
        state.run = { speaker, runId: data.run_id, started: now() };
      } else {
        const profile = grokProfile();
        if (!profile?.apiUrl || !profile.apiKey) throw fail('Grok Bot is not configured on this Orbit server.', 409);
        state.grokAgentId = await grok.ensureSharedAgent(profile, state.grokAgentId);
        const started = await grok.startSharedPrompt(profile, state.grokAgentId, prompt);
        state.run = { speaker, runId: `run_${randomUUID().replaceAll('-', '')}`, started: started.started, nonce: started.nonce, baseline: started.baseline, agentId: state.grokAgentId };
      }
      state.next = other(speaker);
      state.activity = `${labels[speaker]} is replying.`;
    } catch (error) {
      state.run = null;
      state.paused = true;
      state.activity = '';
      append(state, speaker, error?.message || `${labels[speaker]} could not take a turn.`, true);
    }
  }

  async function poll(state) {
    if (!state.run) return { status: 'idle' };
    if (state.run.speaker === 'hermes') {
      const profile = hermesProfile();
      if (!profile) return { status: 'failed', error: 'Hermes is not configured on this Orbit server.' };
      return hermesView(await hermes(profile, `/v1/runs/${state.run.runId}`));
    }
    const profile = grokProfile();
    if (!profile) return { status: 'failed', error: 'Grok Bot is not configured on this Orbit server.' };
    return grok.pollSharedPrompt(profile, state.run);
  }

  async function advance(state) {
    for (let step = 0; step < 4 && state.run; step += 1) {
      let view;
      try { view = await poll(state); }
      catch (error) {
        append(state, state.run.speaker, error?.message || 'That speaker could not be reached.', true);
        state.run = null;
        state.paused = true;
        state.activity = '';
        return;
      }
      if (view.status === 'running') return;
      if (view.status === 'waiting_for_approval') {
        state.activity = view.error || `${labels[state.run.speaker]} is waiting for approval.`;
        state.paused = true;
        return;
      }
      const speaker = state.run.speaker;
      state.run = null;
      append(state, speaker, view.status === 'completed' ? (view.output || `${labels[speaker]} finished without a text reply.`) : (view.error || `${labels[speaker]} could not finish this turn.`), view.status !== 'completed');
      state.turns += 1;
      state.activity = '';
      if (view.status !== 'completed') { state.paused = true; return; }
      if (!state.auto || state.paused || state.turns >= state.maxTurns) {
        if (state.auto && !state.paused && state.turns >= state.maxTurns) {
          state.paused = true;
          append(state, 'note', `Paused after ${state.maxTurns} agent replies. Post a message, choose who speaks next, or press Resume.`);
        }
        return;
      }
      await begin(state, state.next);
    }
  }

  async function stopRun(state) {
    if (!state.run) return;
    const run = state.run;
    try {
      if (run.speaker === 'hermes') {
        const profile = hermesProfile();
        if (profile) await hermes(profile, `/v1/runs/${run.runId}/stop`, {});
      } else {
        const profile = grokProfile();
        if (profile && run.agentId) await grok.stopSharedPrompt(profile, run.agentId);
      }
    } catch (error) {
      append(state, run.speaker, error?.message || 'Stop request failed.', true);
    }
    state.run = null;
    state.activity = '';
  }

  async function operate(body) {
    const key = paneKey(body);
    const state = load(key);
    const operation = body.operation || 'state';
    if (operation === 'state') {
      await advance(state);
    } else if (operation === 'post') {
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) throw fail('Enter a message of 1–16,000 characters.', 400);
      append(state, 'owner', body.text.trim());
      state.turns = 0;
      if (!state.run && state.auto && !state.paused) await begin(state, state.next);
      await advance(state);
    } else if (operation === 'speak') {
      if (!speakers.includes(body.speaker)) throw fail('Choose Hermes or Grok Bot.', 400);
      if (state.run) throw fail('Wait for the current speaker, or press Stop.', 409);
      state.next = body.speaker;
      await begin(state, body.speaker);
      await advance(state);
    } else if (operation === 'settings') {
      if (body.auto !== undefined) state.auto = body.auto === true;
      if (body.next !== undefined) {
        if (!speakers.includes(body.next)) throw fail('Choose Hermes or Grok Bot.', 400);
        state.next = body.next;
      }
      if (body.max_turns !== undefined) {
        if (!Number.isInteger(body.max_turns) || body.max_turns < 1 || body.max_turns > 8) throw fail('The turn limit must be from 1 to 8.', 400);
        state.maxTurns = body.max_turns;
      }
    } else if (operation === 'pause') {
      state.paused = true;
      state.activity = state.run ? `${labels[state.run.speaker]} will finish this reply, then the exchange stays paused.` : 'Paused.';
    } else if (operation === 'resume') {
      state.paused = false;
      state.turns = 0;
      if (!state.run && state.auto) await begin(state, state.next);
      await advance(state);
    } else if (operation === 'stop') {
      await stopRun(state);
      state.paused = true;
      append(state, 'note', 'Stopped. Auto-alternate stays paused until you press Resume.');
    } else throw fail('Unknown shared-agents operation.', 400);
    save(state);
    return state;
  }

  function handle(reply, res, body) {
    const key = `${body.workspace_id || ''}.${body.pane_id || ''}`;
    const previous = chains.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(() => operate(body));
    chains.set(key, result);
    return result.then(state => reply(res, 200, publicState(state))).catch(error => {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      let message = typeof error?.message === 'string' ? error.message : '';
      if (!message.trim() || message.length > 500) message = 'The shared conversation could not complete that request.';
      if (res.headersSent || res.writableEnded) { try { res.end(); } catch {} return; }
      try { return reply(res, status, { error: message }); }
      catch { try { res.end(); } catch {} }
    });
  }

  return { handle };
}
