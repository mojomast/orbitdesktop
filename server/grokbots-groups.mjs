// Group chats for the Grok Bots app: Orbit shared-room engine (shared-agents.mjs) with arbitrary members.
// A member is a specific agent: a Grok/Pi gateway bot by id, a Hermes(-compatible) profile, or a future
// provider. Config lives in <runtime>/grokbots-groups.json; each group's room state in <runtime>/grokbots-groups/<id>/.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSharedAgents } from './shared-agents.mjs';
import { createAgentGateways } from './agent-gateways.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GW_ID = v => UUID.test(v) || /^pi_[a-f0-9]{16}$/.test(v);
const ROOM_NS = '0b0b0b0b-0000-4000-8000-00000000c0de'; // synthetic workspace id for group room keys
const MAX_MEMBERS = 12;
// Build tracking: every member checks build work in on this group's Collab board.
const boardGuidance = group => `Build tracking (Orbit Collab board): when Kyle asks the group to build, fix, or make something, track it on the board with the collab-board command (run it with your terminal tool). This group's id is ${group.id}; always pass --as <your @handle without @>.
- See entries: ~/bin/collab-board ${group.id} list
- Start work: if no open entry fits, create one: ~/bin/collab-board ${group.id} new "<short title>" --as <handle> [--spec "<what done looks like>"]
- Check in when you start or make progress: ~/bin/collab-board ${group.id} checkin <entry-id> "<what you are doing>" --as <handle>
- Move it: ~/bin/collab-board ${group.id} update <entry-id> doing|review|done|blocked "<note>" --as <handle>
Every member who works on a build checks in on its entry, and the finisher sets it to done. Mention the entry id in your chat reply. Chat-only questions need no entry.`;
const GROUP_HARD_CAP_MS = 4 * 60 * 60 * 1000; // a group turn may run this long (4 hours) while it keeps producing output
const GROUP_TURN_MS = 90 * 60 * 1000; // inactivity limit (90 minutes): group members do real work (builds, debugging); 3 and 10 minutes cut them off mid-task
const fail = (m, s = 400) => Object.assign(new Error(m), { status: s });
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const RESERVED = new Set(['owner', 'note', 'all', 'kyle', 'orbit']);

function handleFor(label, taken) {
  let base = clean(label, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'agent';
  if (/^[0-9]/.test(base) || RESERVED.has(base)) base = `a_${base}`.slice(0, 24);
  let h = base, n = 2;
  while (taken.has(h)) h = `${base}${n++}`.slice(0, 32);
  taken.add(h); return h;
}

export function createGroups({ runtimeRoot, catalog, chats, profiles }) {
  const file = path.join(runtimeRoot, 'grokbots-groups.json');
  const roomsDir = path.join(runtimeRoot, 'grokbots-groups');
  fs.mkdirSync(roomsDir, { recursive: true, mode: 0o700 });
  let groups = [];
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); groups = Array.isArray(d?.groups) ? d.groups : []; } catch {}
  // Default responder: one member unless Kyle explicitly picked 'everyone' (older groups defaulted to all implicitly).
  let migrated = false;
  for (const g of groups) if (g.defaultResponder === 'all' && g.defaultChosen !== true && g.members?.length) { g.defaultResponder = g.members[0].id; migrated = true; }
  const save = () => { const t = `${file}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify({ version: 1, groups }), { mode: 0o600 }); fs.renameSync(t, file); };
  if (migrated) save();
  const engines = new Map();
  const chain = new Map();
  const serial = (id, fn) => { const p = (chain.get(id) || Promise.resolve()).then(fn, fn); chain.set(id, p.catch(() => {})); return p; };

  const profileOf = id => { const f = profiles().find(x => x.p.id === id); return f ? f : null; };

  // ---- isolation: every gateway member talks through a per-group clone, every Hermes member through a per-group session
  async function gw(f, name, body) {
    const r = await fetch(`${String(f.p.apiUrl).replace(/\/$/, '')}/api/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${f.p.apiKey}`, 'Content-Type': 'application/json', 'x-sand-request-id': randomUUID() }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000), redirect: 'error' });
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
    if (!r.ok) throw fail(`${f.providerLabel} ${name} failed (HTTP ${r.status}).`, r.status === 404 ? 404 : 502);
    return j;
  }
  async function ensureClones(g) {
    let changed = false;
    for (const m of g.members) {
      const f = profileOf(m.profile); if (!f || f.adapter.kind !== 'gateway' || m.cloneId) continue;
      if (m.sourceId === undefined) m.sourceId = m.agentId || null; // migrate: older records pointed at the source bot itself
      let description = '';
      if (m.sourceId) { try { const rows = await gw(f, 'listAgents', {}); const src = (Array.isArray(rows) ? rows : []).find(a => a && a.id === m.sourceId); description = String(src?.description || '').slice(0, 500); } catch {} }
      const name = clean(`${m.label} · ${g.name}`, 80);
      const created = await gw(f, 'createAgent', { name, description: description || `Orbit group chat "${clean(g.name, 60)}" member. Not the owner’s 1-on-1 conversation.`, isIntroductionSuppressed: true });
      const id = created?.agent?.id; if (!GW_ID(id || '')) throw fail(`${f.providerLabel} did not return a usable clone id.`, 502);
      try { await gw(f, 'setAgentHiddenFromSidebar', { id, isHidden: true }); } catch {}
      m.cloneId = id; m.agentId = id; m.agentName = name; changed = true;
    }
    for (const m of g.members) { const f = profileOf(m.profile); if (f && f.adapter.kind === 'sessions' && !m.hermesSession) { m.hermesSession = `orbit-group-${randomUUID()}`; changed = true; } }
    if (changed) { save(); const e = engines.get(g.id); if (e) e.sig = ''; }
  }
  async function dropMember(m) {
    const f = profileOf(m.profile); if (!f) return;
    try {
      if (f.adapter.kind === 'gateway' && m.cloneId) await gw(f, f.provider === 'pi' ? 'archiveAgent' : 'deleteAgent', { id: m.cloneId });
      else if (f.adapter.kind === 'sessions' && m.hermesSession) {
        const r = await fetch(`${String(f.p.apiUrl).replace(/\/$/, '')}/api/sessions/${encodeURIComponent(m.hermesSession)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${f.p.apiKey}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
        await r.text().catch(() => {});
      }
    } catch {}
  }
  const hidden = () => ({ agents: new Set(groups.flatMap(g => g.members.map(m => m.cloneId).filter(Boolean))), sessions: new Set(groups.flatMap(g => g.members.map(m => m.hermesSession).filter(Boolean))) });

  function memberGateways(group) {
    const inner = new Map();
    const forMember = m => {
      if (inner.has(m.id)) return inner.get(m.id);
      const f = profileOf(m.profile);
      const p = f ? { ...f.p, provider: f.provider } : null;
      const isHermes = f && f.adapter.kind === 'sessions';
      const g = createAgentGateways({ chats: chats(), hermesProfile: () => (isHermes ? p : null), gatewayProfile: prov => (!isHermes && f && prov === f.provider ? p : null), sharedTimeoutMs: GROUP_TURN_MS, interimMessages: true, longTurns: true });
      const rec = { g, speaker: isHermes ? 'hermes' : (f ? f.provider : m.provider), ok: !!f };
      inner.set(m.id, rec); return rec;
    };
    const member = handle => { const m = group.members.find(x => x.id === handle); if (!m) throw fail(`${handle} is not in this group.`, 409); return m; };
    return {
      async startSpeaker({ speaker, prompt, instructions, grokAgentId }) {
        const m = member(speaker); const r = forMember(m);
        if (!r.ok) throw fail(`${m.label}'s provider profile is not configured.`, 409);
        if (r.speaker !== 'hermes' && !m.cloneId) throw fail(`${m.label} has no group clone yet; post again to create it.`, 409);
        const out = await r.g.startSpeaker({ speaker: r.speaker, prompt, instructions, hermesSession: m.hermesSession, grokAgentId: r.speaker === 'hermes' ? '' : m.cloneId, grokAgentName: m.agentName || undefined });
        return out;
      },
      async pollSpeaker(run) { if (!run) return { status: 'idle' }; const m = member(run.speaker); return forMember(m).g.pollSpeaker({ ...run, speaker: forMember(m).speaker }); },
      async stopSpeaker(run) { if (!run) return; const m = group.members.find(x => x.id === run.speaker); if (m) return forMember(m).g.stopSpeaker({ ...run, speaker: forMember(m).speaker }); },
    };
  }

  function engine(group) {
    let e = engines.get(group.id);
    if (e && e.sig === JSON.stringify([group.members, group.defaultResponder, group.mode || 'parallel'])) return e.room;
    if (e) e.room.dispose();
    const dir = path.join(roomsDir, group.id);
    const room = createSharedAgents({ directory: dir, gateways: memberGateways(group), members: group.members.map(m => ({ id: m.id, label: m.label })), defaultResponder: group.defaultResponder || 'all', guidance: boardGuidance(group), parallel: group.mode !== 'sequential', turnTimeoutMs: GROUP_TURN_MS, delegationTimeoutMs: GROUP_TURN_MS, hardCapMs: GROUP_HARD_CAP_MS });
    engines.set(group.id, { room, sig: JSON.stringify([group.members, group.defaultResponder, group.mode || 'parallel']) });
    return room;
  }
  const call = (group, body) => new Promise((resolve, reject) => {
    const reply = (_res, status, obj) => (status >= 400 ? reject(fail(obj?.error || 'Group request failed.', status)) : resolve(obj));
    engine(group).handle(reply, {}, { workspace_id: ROOM_NS, pane_id: group.id, ...body }).catch(reject);
  });
  for (const g of groups) { try { engine(g); } catch {} } // resume ticking for groups with a run in flight

  const view = g => ({ id: g.id, name: g.name, defaultResponder: g.defaultResponder || 'all', mode: g.mode === 'sequential' ? 'sequential' : 'parallel', createdAt: g.createdAt,
    members: g.members.map(m => ({ id: m.id, label: m.label, provider: m.provider, profile: m.profile, agentId: m.sourceId ?? m.agentId ?? null, cloneId: m.cloneId || null })) });
  const find = id => { const g = groups.find(x => x.id === id); if (!g) throw fail('Unknown group.', 404); return g; };

  // A member spec from the client: {profile, agent?}. Labels and kinds come from the server's own roster.
  async function resolveMember(spec, taken, rosterFor) {
    const f = profileOf(String(spec?.profile || ''));
    if (!f) throw fail('Unknown provider profile for a member.');
    if (f.adapter.kind === 'sessions') {
      return { id: handleFor(spec.label || f.label.split(' · ')[0] || f.provider, taken), label: clean(spec.label || f.label.split(' · ')[0], 60) || f.provider, provider: f.provider, profile: f.p.id, hermesSession: `orbit-group-${randomUUID()}` };
    }
    const agent = String(spec?.agent || '');
    if (agent && !GW_ID(agent)) throw fail('Invalid agent id for a member.');
    let name = '';
    if (agent) { const rows = await rosterFor(f.p.id); const row = rows.find(a => a.id === agent); if (!row) throw fail('That bot is not in its provider roster.', 404); name = row.name; }
    const label = clean(spec.label || name || f.providerLabel, 60);
    return { id: handleFor(label, taken), label, provider: f.provider, profile: f.p.id, sourceId: agent || null };
  }

  async function handle(b, rosterFor) {
    switch (b.op) {
      case 'list': return { groups: groups.map(view) };
      case 'create': {
        const name = clean(b.name, 80); if (!name) throw fail('Name the group.');
        const specs = Array.isArray(b.members) ? b.members.slice(0, MAX_MEMBERS) : [];
        if (!specs.length) throw fail('Pick at least one member.');
        const taken = new Set(); const members = [];
        for (const s of specs) members.push(await resolveMember(s, taken, rosterFor));
        const g = { id: randomUUID(), name, members, defaultResponder: members[0].id, createdAt: Date.now() };
        try { await ensureClones(g); } catch (e) { for (const m of members) await dropMember(m); throw e; }
        groups.push(g); save(); engine(g); return { group: view(g) };
      }
      case 'update': {
        const g = find(b.group);
        return serial(g.id, async () => {
          if (typeof b.name === 'string') { const n = clean(b.name, 80); if (!n) throw fail('Name the group.'); g.name = n; }
          if (typeof b.defaultResponder === 'string') { if (b.defaultResponder !== 'all' && !g.members.some(m => m.id === b.defaultResponder)) throw fail('Default responder must be all or a member.'); g.defaultResponder = b.defaultResponder; g.defaultChosen = true; }
          if (typeof b.mode === 'string') { if (!['parallel', 'sequential'].includes(b.mode)) throw fail('Mode must be parallel or sequential.'); g.mode = b.mode; }
          if (Array.isArray(b.remove)) { for (const m of g.members.filter(m => b.remove.includes(m.id))) await dropMember(m); g.members = g.members.filter(m => !b.remove.includes(m.id)); if (g.defaultResponder !== 'all' && !g.members.some(m => m.id === g.defaultResponder)) g.defaultResponder = g.members[0]?.id || 'all'; }
          if (Array.isArray(b.add) && b.add.length) {
            if (g.members.length + b.add.length > MAX_MEMBERS) throw fail(`A group can have at most ${MAX_MEMBERS} members.`);
            const taken = new Set(g.members.map(m => m.id)); for (const s of b.add) g.members.push(await resolveMember(s, taken, rosterFor));
          }
          if (!g.members.length) throw fail('A group needs at least one member.');
          await ensureClones(g); save(); engine(g); return { group: view(g) };
        });
      }
      case 'delete': {
        const g = find(b.group);
        return serial(g.id, async () => {
          try { await call(g, { operation: 'stop' }); } catch {}
          const e = engines.get(g.id); if (e) e.room.dispose(); engines.delete(g.id);
          for (const m of g.members) await dropMember(m);
          groups = groups.filter(x => x.id !== g.id); save();
          fs.rmSync(path.join(roomsDir, g.id), { recursive: true, force: true });
          return { deleted: true };
        });
      }
      case 'state': { const g = find(b.group); return { group: view(g), room: await call(g, { operation: 'state' }) }; }
      case 'post': {
        const g = find(b.group); const text = typeof b.text === 'string' ? b.text.trim() : '';
        if (!text || text.length > 16000) throw fail('Message must be 1–16,000 characters.');
        if (/^\/collab(\s|$)/.test(text)) throw fail('/collab is not available in group chats.');
        // Kyle can speak anytime: a stopped room resumes on his next message.
        await ensureClones(g);
        const cur = await call(g, { operation: 'state' });
        if (cur.paused) await call(g, { operation: 'resume' });
        return { group: view(g), room: await call(g, { operation: 'post', text }) };
      }
      case 'stop': { const g = find(b.group); return { group: view(g), room: await call(g, { operation: 'stop' }) }; }
      default: throw fail('Unknown group operation.');
    }
  }
  // Collab board link (server/collab-board.mjs): one board-only Collab project per group.
  const findGroup = id => groups.find(x => x.id === id) || null;
  const boardOf = id => findGroup(id)?.board || null;
  const linkBoard = (id, link) => { const g = findGroup(id); if (g) { g.board = { workspace: link.workspace, projectId: link.projectId }; save(); } };
  return { handle, hidden, find: findGroup, boardOf, linkBoard };
}
