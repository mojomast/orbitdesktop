// Per-conversation state for the Grok Bots app that must survive reloads:
// composer drafts, queued messages, conversation colours, notification and
// context settings. The app runs in an opaque-origin sandbox (no localStorage),
// so this lives in <runtime>/grokbots-prefs.json (0600), written atomically.
// Everything is bounded; nothing here is ever sent to a provider.
import fs from 'node:fs';
import path from 'node:path';

export const PREF_LIMITS = Object.freeze({ text: 100000, queue: 20, drafts: 300, keys: 1000, bytes: 16 * 1024 * 1024, attachments: 10 });
const KEY = /^[A-Za-z0-9_:|.@-]{1,300}$/;
const SECTIONS = { themes: v => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) ? v.toLowerCase() : null, muted: v => v === true ? true : null, context: v => v === true ? true : null };
const SETTINGS = { notifications: v => v === true || v === false ? v : undefined };
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const ATTACHMENT_ID = /^[a-f0-9-]{36}$/;

function cleanAttachments(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > PREF_LIMITS.attachments) throw fail('Too many attachments.');
  return list.map(a => {
    if (!a || !ATTACHMENT_ID.test(String(a.id || ''))) throw fail('Invalid attachment.');
    return { id: a.id, name: String(a.name || 'file').slice(0, 200), size: Number(a.size) || 0, type: String(a.type || '').slice(0, 100) };
  });
}

export function createPrefs({ runtimeRoot }) {
  const file = path.join(runtimeRoot, 'grokbots-prefs.json');
  let state = { version: 1, drafts: {}, themes: {}, muted: {}, context: {}, settings: {} };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && typeof d === 'object') state = { ...state, ...d, settings: { ...(d.settings || {}) } }; } catch {}
  function save() {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > PREF_LIMITS.bytes) throw fail('Saved drafts are too large. Send or clear some drafts first.', 413);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file);
  }
  function draft({ key, text, queue, attachments }) {
    if (!KEY.test(String(key || ''))) throw fail('Invalid conversation key.');
    if (typeof text !== 'string' || text.length > PREF_LIMITS.text) throw fail('Draft must be at most 100,000 characters.');
    const q = queue === undefined ? undefined : Array.isArray(queue) ? queue : null;
    if (q === null || (q && q.length > PREF_LIMITS.queue)) throw fail(`At most ${PREF_LIMITS.queue} queued messages.`);
    const items = q?.map(item => {
      if (!item || typeof item.text !== 'string' || item.text.length > PREF_LIMITS.text || !/^[A-Za-z0-9_-]{1,64}$/.test(String(item.id || ''))) throw fail('Invalid queued message.');
      return { id: item.id, text: item.text, ...(item.attachments ? { attachments: cleanAttachments(item.attachments) } : {}) };
    });
    const att = cleanAttachments(attachments);
    const prev = state.drafts[key] || {};
    const next = { text, queue: items ?? prev.queue ?? [], ...(att !== undefined ? { attachments: att } : prev.attachments ? { attachments: prev.attachments } : {}), at: Date.now() };
    if (!next.text && !next.queue.length && !(next.attachments || []).length) delete state.drafts[key];
    else state.drafts[key] = next;
    const keys = Object.keys(state.drafts);
    if (keys.length > PREF_LIMITS.drafts) for (const k of keys.sort((a, b) => state.drafts[a].at - state.drafts[b].at).slice(0, keys.length - PREF_LIMITS.drafts)) delete state.drafts[k];
    save();
    return { ok: true };
  }
  function set({ section, key, value }) {
    if (section === 'settings') {
      if (!Object.hasOwn(SETTINGS, key)) throw fail('Unknown setting.');
      const v = SETTINGS[key](value); if (v === undefined) throw fail('Invalid setting value.');
      state.settings[key] = v; save(); return { ok: true };
    }
    const norm = SECTIONS[section]; if (!norm) throw fail('Unknown preference.');
    if (!KEY.test(String(key || ''))) throw fail('Invalid conversation key.');
    const v = norm(value);
    if (v === null) delete state[section][key];
    else { if (!state[section][key] && Object.keys(state[section]).length >= PREF_LIMITS.keys) throw fail('Too many saved preferences.'); state[section][key] = v; }
    save(); return { ok: true };
  }
  function handle(b) {
    if (b.op === 'get') return { drafts: state.drafts, themes: state.themes, muted: state.muted, context: state.context, settings: state.settings };
    if (b.op === 'draft') return draft(b);
    if (b.op === 'set') return set(b);
    throw fail('Unknown preference operation.');
  }
  return { handle, read: () => state };
}
