// Group-chat build tracking on the Orbit Collab board. Loopback-only POST /api/collab-board with a dedicated
// key (~/.orbit-runtime/collab-board.key), used by ~/bin/collab-board. Each group gets one board-only Collab
// project (no planner, no scheduled turns); entries are its tasks. The group record links to the project.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (m, s = 400) => Object.assign(new Error(m), { status: s });
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

export function createCollabBoard({ runtimeRoot, collab, groups, workspace }) {
  const keyFile = path.join(runtimeRoot, 'collab-board.key');
  let key;
  try { key = fs.readFileSync(keyFile, 'utf8').trim(); } catch {}
  if (!key || key.length < 32) { key = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 }); }
  try { fs.chmodSync(keyFile, 0o600); } catch {}
  const keyBuf = Buffer.from(key);
  const chain = new Map();
  const serial = (id, fn) => { const p = (chain.get(id) || Promise.resolve()).then(fn, fn); chain.set(id, p.catch(() => {})); return p; };

  const entryView = t => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, summary: t.summary || '', checkins: (t.checkins || []).slice(-3) });

  async function boardFor(g, create) {
    const ws = workspace();
    if (!UUID.test(ws || '')) throw fail('No Orbit workspace is configured for group boards.', 409);
    const link = groups().boardOf(g.id);
    if (link?.projectId) {
      try { const st = await collab()({ workspace_id: link.workspace, project_id: link.projectId, operation: 'state' }); return { link, st }; }
      catch (e) { if (e.status !== 404) throw e; }
    }
    if (!create) return { link: null, st: null };
    const st = await collab()({ workspace_id: ws, pane_id: '', operation: 'create', board_only: true, title: clean(`Group: ${g.name}`, 80), goal: clean(`Build work started in the Grok Bots group chat "${g.name}".`, 400), by: 'orbit' });
    const next = { workspace: ws, projectId: st.project.id };
    groups().linkBoard(g.id, next);
    return { link: next, st };
  }

  async function op(b) {
    const g = groups().find(String(b.group || ''));
    if (!g) throw fail('Unknown group. Use the group id from your group-chat instructions.', 404);
    const by = clean(b.by, 64);
    if (by && !g.members.some(m => m.id === by)) throw fail('--as must be your @handle in this group.', 400);
    return serial(g.id, async () => {
      if (b.op === 'list') {
        const { link, st } = await boardFor(g, false);
        return { group: g.id, board: link ? link.projectId : null, entries: st ? st.tasks.map(entryView) : [] };
      }
      const action = { new: 'add', add: 'add', update: 'update', checkin: 'checkin' }[b.op];
      if (!action) throw fail('Use list, new, update, or checkin.', 400);
      const { link } = await boardFor(g, action === 'add');
      if (!link) throw fail('This group has no board entries yet. Create one with: collab-board <group> new "<title>" --as <you>.', 404);
      const st = await collab()({ workspace_id: link.workspace, project_id: link.projectId, operation: 'board', title: b.title, spec: b.spec, status: b.status, note: b.note, owner: b.owner, task_id: b.entry, by: by || 'agent', board_action: action });
      const t = st.tasks.find(x => x.id === st.entry);
      return { group: g.id, board: link.projectId, entry: t ? entryView(t) : { id: st.entry } };
    });
  }

  async function handle(req, res) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    const ra = req.socket?.remoteAddress || '';
    if (!(ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1')) return send(403, { error: 'loopback only' });
    if (req.headers.origin) return send(403, { error: 'no browser callers' });
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (got.length !== keyBuf.length || !crypto.timingSafeEqual(got, keyBuf)) return send(401, { error: 'unauthorized' });
    let raw = '';
    for await (const part of req) { raw += part; if (raw.length > 16000) { send(413, { error: 'too large' }); return req.destroy(); } }
    let b; try { b = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid JSON' }); }
    try { return send(200, await op(b)); } catch (e) { return send(e.status || 502, { error: clean(e.message || 'failed', 300) }); }
  }
  return { handle, op };
}
