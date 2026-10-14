import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validSessionId, sanitizeSessions, sanitizeHistory } from './agent-profiles.mjs';
import { GATEWAY_PROVIDERS, isGatewayProvider, providerLabel } from './agent-providers.mjs';
import {
  AUTO_COMPACT_RATIO, CONTEXT_SYSTEM_TEXT, CONTEXT_TOOLS_TEXT, compactTranscript, contextWindowFor,
  measureContext, meterLevel, shouldAutoCompact, smallerWindow, calibrate,
} from '../src/context-budget.ts';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = (status, message) => Object.assign(Error(message), { status });

function providerOf(profile) {
  return isGatewayProvider(profile?.provider) ? profile.provider : 'hermes';
}

function modelOf(profile) {
  if (typeof profile?.model === 'string' && profile.model.trim()) return profile.model.trim();
  const label = String(profile?.label || '');
  const split = label.split(' · ');
  return split.length > 1 ? split.slice(1).join(' · ') : 'gateway model';
}

export function tokenRatioKey(profile) {
  if (!profile?.id) return '';
  return `${profile.id}:${modelOf(profile)}`.slice(0, 200);
}

function gatewayOf(profile) {
  if (isGatewayProvider(providerOf(profile))) return providerLabel(providerOf(profile));
  try {
    const url = new URL(profile.apiUrl);
    return `Hermes :${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch { return 'Hermes'; }
}

function publicMessage(message) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string' || !message.text.trim()) return null;
  return { role: message.role, text: message.text.slice(0, 16000) };
}

function publicMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(publicMessage).filter(Boolean).slice(-100);
}

export function hermesCompressionNote(metadata = {}) {
  const prompt = Number(metadata.usage?.prompt_tokens ?? metadata.prompt_tokens);
  return {
    owner: 'hermes',
    compresses: true,
    compressed: metadata.compressed === true || metadata.compression?.active === true,
    prompt_tokens: Number.isFinite(prompt) && prompt >= 0 ? Math.round(prompt) : null,
    note: 'Hermes compresses this session on the gateway from reported usage. Orbit is not compacting it again.',
  };
}

function ratioPath(directory) {
  return path.join(directory, 'token-ratios.json');
}

export function readTokenRatio(directory, key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ratioPath(directory), 'utf8'));
    const ratio = Number(parsed?.[key]);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  } catch { return null; }
}

export function writeTokenRatio(directory, key, ratio) {
  const clamped = calibrate(1, ratio);
  if (!clamped || typeof key !== 'string' || !key || key.length > 200) return;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let current = {};
  try { current = JSON.parse(fs.readFileSync(ratioPath(directory), 'utf8')); } catch { current = {}; }
  if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
  current[key] = clamped;
  const dest = ratioPath(directory);
  const temp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(current), { mode: 0o600 });
  fs.renameSync(temp, dest);
}

function memoryPath(directory) {
  return path.join(directory, 'pane-providers.json');
}

function readMemory(directory) {
  try {
    const parsed = JSON.parse(fs.readFileSync(memoryPath(directory), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function rememberPaneProvider(directory, workspace, pane, profileId) {
  if (!uuid.test(workspace || '') || !uuid.test(pane || '') || typeof profileId !== 'string') return;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const current = readMemory(directory);
  current[`${workspace}:${pane}`] = profileId.slice(0, 64);
  const dest = memoryPath(directory);
  const temp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(current), { mode: 0o600 });
  fs.renameSync(temp, dest);
}

export function rememberedPaneProvider(directory, workspace, pane) {
  if (!uuid.test(workspace || '') || !uuid.test(pane || '')) return null;
  const value = readMemory(directory)[`${workspace}:${pane}`];
  return typeof value === 'string' ? value : null;
}

function saveRaw(directory, profileId, sessionId, raw) {
  const dir = path.join(directory, 'transcript-raw');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = createHash('sha256').update(`${profileId}\0${sessionId}`).digest('hex') + '.json';
  const dest = path.join(dir, name);
  const temp = `${dest}.${process.pid}.tmp`;
  const body = JSON.stringify({ profile_id: profileId, session_id: sessionId, saved_at: new Date().toISOString(), messages: raw });
  fs.writeFileSync(temp, body, { mode: 0o600 });
  fs.renameSync(temp, dest);
  return name;
}

export function createAgentContextApi({ configuration, shared, conversations, chats, upstreamFor, runtimeDirectory, workspaceRead, workspaceContext }) {
  // One chat surface per gateway provider; Hermes profiles keep the run API.
  const chatFor = profile => (isGatewayProvider(profile?.provider) ? chats?.get(profile.provider) || null : null);
  function requireWorkspace(body) {
    if (!uuid.test(body.workspace_id || '')) throw fail(400, 'Invalid conversation scope.');
    if (!workspaceRead) throw fail(503, 'Authoritative workspace access unavailable.');
    try { workspaceRead(body.workspace_id); } catch { throw fail(404, 'Workspace unavailable.'); }
  }

  async function loadMessages(profile, sessionId) {
    const chat = chatFor(profile);
    if (chat) return chat.readTranscript(profile, sessionId);
    const history = await upstreamFor(profile, `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=80&offset=0`);
    return sanitizeHistory(history);
  }

  async function probe(profile) {
    const chat = chatFor(profile);
    if (chat) return chat.probe(profile);
    try {
      const caps = await upstreamFor(profile, '/v1/capabilities');
      const tools = !!(caps?.endpoints?.toolsets || caps?.endpoints?.tools || caps?.features?.tools || caps?.features?.tool_execution);
      return { ok: true, tools };
    } catch { return { ok: false, tools: false }; }
  }

  async function providerMenu(body) {
    requireWorkspace(body);
    const providers = [];
    for (const item of configuration?.list || []) {
      const profile = configuration.get(item.id);
      if (!profile) continue;
      const health = await probe(profile);
      const model = modelOf(profile);
      providers.push({
        id: profile.id,
        label: profile.label,
        provider: providerOf(profile),
        gateway: gatewayOf(profile),
        model,
        health: health.ok ? 'up' : 'down',
        context_window: contextWindowFor(model, providerOf(profile)),
        tools: health.tools === true,
        configured: true,
      });
    }
    return {
      providers,
      remembered_profile_id: rememberedPaneProvider(runtimeDirectory, body.workspace_id, body.pane_id),
      auto_compact_ratio: AUTO_COMPACT_RATIO,
    };
  }

  async function historySearch(body) {
    requireWorkspace(body);
    const offset = body.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw fail(400, 'Invalid session page.');
    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 200).toLowerCase() : '';
    const providerFilter = body.provider === 'hermes' || GATEWAY_PROVIDERS.includes(body.provider) ? body.provider : '';
    const rows = [];
    let hasMore = false;
    let partial = false;
    for (const item of configuration?.list || []) {
      const profile = configuration.get(item.id);
      if (!profile || (providerFilter && providerOf(profile) !== providerFilter)) continue;
      let page = { data: [], has_more: false };
      try {
        const chat = chatFor(profile);
        page = sanitizeSessions(chat ? await chat.sessionPage(profile, offset) : await upstreamFor(profile, `/api/sessions?limit=100&offset=${offset}`));
      } catch (error) { if (error.status !== 404) partial = true; continue; }
      if (page.has_more) hasMore = true;
      let examined = 0;
      for (const session of page.data) {
        const meta = conversations.read({ workspace_id: body.workspace_id, profile_id: profile.id, session_id: session.id });
        const title = meta.title || session.title || session.id;
        let matched = !query || `${title} ${session.title || ''} ${session.id}`.toLowerCase().includes(query);
        let snippet = '';
        if (query && !matched) {
          if (examined >= 12) { partial = true; continue; }
          examined += 1;
          try {
            const messages = await loadMessages(profile, session.id);
            const hit = messages.find(message => message.text.toLowerCase().includes(query));
            if (hit) { matched = true; snippet = hit.text.slice(0, 180); }
          } catch { partial = true; }
        }
        if (!matched) continue;
        const linked = uuid.test(body.pane_id || '') ? shared.read(body.workspace_id, body.pane_id) : null;
        const running = (!!linked?.run && linked.session === session.id && linked.profile_id === profile.id) || (uuid.test(body.pane_id || '') && shared.hasActive(profile.id, session.id, body.workspace_id, body.pane_id));
        rows.push({
          session_id: session.id,
          profile_id: profile.id,
          provider: providerOf(profile),
          title,
          updated_at: session.updated_at || meta.updated_at || '',
          pinned: meta.pinned === true,
          revision: meta.revision || 0,
          snippet,
          running,
        });
      }
    }
    return { conversations: rows.slice(0, 200), has_more: hasMore, partial, note: partial ? 'Body search covered a bounded page. Older matches may remain.' : 'Search covers titles and a bounded set of transcripts.' };
  }

  async function historyTranscript(body) {
    requireWorkspace(body);
    const profile = configuration.get(body.target_profile_id);
    if (!profile) throw fail(400, 'Unknown profile.');
    if (!validSessionId(body.target_session_id)) throw fail(400, 'Invalid conversation identity.');
    let messages = [];
    try { messages = await loadMessages(profile, body.target_session_id); }
    catch (error) { if (error.status === 404) throw fail(404, 'Conversation transcript is unavailable.'); throw error; }
    const meta = conversations.read({ workspace_id: body.workspace_id, profile_id: profile.id, session_id: body.target_session_id });
    const pane = uuid.test(body.pane_id || '') ? body.pane_id : '00000000-0000-4000-8000-000000000000';
    const workspace = uuid.test(body.workspace_id || '') ? body.workspace_id : pane;
    const linked = uuid.test(body.pane_id || '') ? shared.read(body.workspace_id, body.pane_id) : null;
    const running = shared.hasActive(profile.id, body.target_session_id, workspace, pane) || (linked?.session === body.target_session_id && linked?.profile_id === profile.id && !!linked?.run);
    return {
      read_only: true,
      running: !!running,
      provider: providerOf(profile),
      profile_id: profile.id,
      session_id: body.target_session_id,
      title: meta.title || body.target_session_id,
      model: modelOf(profile),
      messages,
    };
  }

  function measurePane(current, profile, workspaceId, reported) {
    let files = '';
    try { if (workspaceContext && workspaceId) files = String(workspaceContext(workspaceId) || ''); } catch { files = ''; }
    const ratio = readTokenRatio(runtimeDirectory, tokenRatioKey(profile));
    return measureContext({
      messages: current?.messages || [],
      system: CONTEXT_SYSTEM_TEXT,
      tools: CONTEXT_TOOLS_TEXT,
      files: files.slice(0, 8000),
      reported,
      ratio,
    });
  }

  async function hermesState(profile, sessionId) {
    let metadata = {};
    try { metadata = await upstreamFor(profile, `/api/sessions/${encodeURIComponent(sessionId)}`); } catch { metadata = {}; }
    return hermesCompressionNote(metadata);
  }

  async function ownsOrbitCopy(profile, current) {
    if (isGatewayProvider(providerOf(profile))) return true;
    if (current?.orbit_owned !== true) return false;
    try {
      const page = await upstreamFor(profile, `/api/sessions/${encodeURIComponent(current.session)}/messages?limit=1&offset=0`);
      if (Array.isArray(page?.data) && page.data.length > 0) return false;
    } catch (error) { if (error.status !== 404) return false; }
    return true;
  }

  function writeView(body, current, profile, view, extra = {}) {
    const messages = publicMessages(view);
    const state = shared.write(body.workspace_id, body.pane_id, {
      ...current,
      ...extra,
      messages,
      binding_revision: current.binding_revision,
    });
    return state;
  }

  async function compact(body, linked) {
    if (body.confirm !== true && body.automatic !== true) throw fail(400, 'Confirm compaction before Orbit rewrites this transcript view.');
    const profile = configuration.get(linked.profile_id);
    if (!profile) throw fail(400, 'Unknown profile.');
    const orbitCopy = await ownsOrbitCopy(profile, linked);
    const measured = measurePane(linked, profile, body.workspace_id);
    const window = contextWindowFor(modelOf(profile), providerOf(profile));
    if (!orbitCopy) {
      const hermes = providerOf(profile) === 'hermes' ? await hermesState(profile, linked.session) : null;
      return { compacted: false, hermes, measure: measured, context_window: window, level: meterLevel(measured.used, window), note: hermes?.note || 'This transcript is not an Orbit-owned copy.' };
    }
    if (body.automatic === true && !shouldAutoCompact(measured.used, window)) {
      return { compacted: false, measure: measured, context_window: window, level: meterLevel(measured.used, window), note: 'Context is under the auto-compact threshold.' };
    }
    const result = compactTranscript(linked.messages || []);
    const raw_file = saveRaw(runtimeDirectory, profile.id, linked.session, result.raw);
    const preamble = result.summary;
    const state = writeView(body, linked, profile, result.view, { orbit_owned: true, orbit_preamble: preamble });
    const after = measurePane(state, profile, body.workspace_id);
    return { compacted: true, pruned_tools: result.pruned_tools, raw_file, summary: result.summary, state, measure: after, context_window: window, level: meterLevel(after.used, window) };
  }

  async function switchProvider(body, linked) {
    const target = configuration.get(body.target_profile_id);
    if (!target) throw fail(400, 'Unknown profile.');
    if (linked.run || shared.hasActive(linked.profile_id, linked.session, body.workspace_id, body.pane_id)) throw fail(409, 'This conversation is already running.');
    const currentProfile = configuration.get(linked.profile_id);
    const nextModel = modelOf(target);
    const nextWindow = contextWindowFor(nextModel, providerOf(target));
    const measured = measurePane(linked, currentProfile || target, body.workspace_id);
    if (target.id === linked.profile_id && modelOf(currentProfile) === nextModel) {
      return { switched: false, suggest_compact: false, state: linked, measure: measured, context_window: nextWindow };
    }
    if (smallerWindow(measured.used, nextWindow) && body.acknowledge_smaller !== true) {
      return { switched: false, suggest_compact: true, used: measured.used, context_window: nextWindow, source: measured.source, provider: providerOf(target), model: nextModel, hermes: providerOf(currentProfile) === 'hermes' };
    }
    const compacted = compactTranscript(linked.messages || []);
    saveRaw(runtimeDirectory, linked.profile_id, linked.session, compacted.raw);
    const marker = `Switched to ${target.label} · ${nextModel}`;
    const view = [{ role: 'assistant', text: marker }, ...compacted.view];
    let sessionId;
    let title = `Fork of ${linked.title || linked.session}`.slice(0, 100);
    const targetChat = chatFor(target);
    if (targetChat) {
      const created = await targetChat.createConversation(target, title.slice(0, 80));
      sessionId = created.id;
      title = created.title || title;
    } else sessionId = `orbit-${randomUUID()}`;
    if (shared.locks.has(`session:${target.id}:${sessionId}`) || shared.hasActive(target.id, sessionId, body.workspace_id, body.pane_id)) throw fail(409, 'This conversation is already running.');
    const state = shared.write(body.workspace_id, body.pane_id, {
      session: sessionId,
      profile_id: target.id,
      binding_revision: linked.binding_revision + 1,
      messages: publicMessages(view),
      title,
      history_unstarted: !chatFor(target),
      orbit_owned: true,
      orbit_preamble: compacted.summary,
    });
    rememberPaneProvider(runtimeDirectory, body.workspace_id, body.pane_id, target.id);
    return { switched: true, suggest_compact: false, marker, state, context_window: nextWindow };
  }

  async function fork(body, linked) {
    if (linked.run) throw fail(409, 'This conversation is already running.');
    const source = configuration.get(body.source_profile_id);
    const target = configuration.get(body.target_profile_id || linked.profile_id);
    if (!source || !target) throw fail(400, 'Unknown profile.');
    if (!validSessionId(body.source_session_id)) throw fail(400, 'Invalid conversation identity.');
    const upto = body.upto;
    let sourceMessages = [];
    try { sourceMessages = await loadMessages(source, body.source_session_id); }
    catch (error) { if (error.status === 404) throw fail(404, 'Conversation transcript is unavailable.'); throw error; }
    if (!Number.isSafeInteger(upto) || upto < 0 || upto >= sourceMessages.length) throw fail(400, 'Choose a message to fork from.');
    const slice = sourceMessages.slice(0, upto + 1);
    const different = source.id !== target.id || providerOf(source) !== providerOf(target);
    const compacted = compactTranscript(slice);
    const view = different ? [{ role: 'assistant', text: `Switched to ${target.label} · ${modelOf(target)}` }, ...compacted.view] : publicMessages(slice);
    saveRaw(runtimeDirectory, source.id, body.source_session_id, slice);
    let sessionId;
    let title = `Fork of ${body.source_session_id}`.slice(0, 100);
    const targetChat = chatFor(target);
    if (targetChat) {
      const created = await targetChat.createConversation(target, title.slice(0, 80));
      sessionId = created.id;
      title = created.title || title;
    } else sessionId = `orbit-${randomUUID()}`;
    if (shared.hasActive(target.id, sessionId, body.workspace_id, body.pane_id)) throw fail(409, 'This conversation is already running.');
    const state = shared.write(body.workspace_id, body.pane_id, {
      session: sessionId,
      profile_id: target.id,
      binding_revision: linked.binding_revision + 1,
      messages: publicMessages(view),
      title,
      history_unstarted: !chatFor(target),
      orbit_owned: true,
      orbit_preamble: different ? compacted.summary : '',
    });
    rememberPaneProvider(runtimeDirectory, body.workspace_id, body.pane_id, target.id);
    return { forked: true, state, copied: !different };
  }

  return { providerMenu, historySearch, historyTranscript, compact, switchProvider, fork, measurePane };
}
