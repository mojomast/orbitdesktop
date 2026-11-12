// File attachments for the Grok Bots app. Providers' send APIs are text-only
// (docs/GROK_PARITY.md), so an attachment is stored on the Orbit host and the
// message carries its absolute path; agents on this host open it with their
// own file tools. Small text files are also inlined when they fit the prompt cap.
//
// Limits follow the bundle limits: at most 10 files and 100 MB per message,
// 25 MB per file. Files live in <runtime>/grokbots-uploads/<id>/ (0700/0600)
// and are pruned after 30 days.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const UPLOAD_LIMITS = Object.freeze({ fileBytes: 25 * 1024 * 1024, messageBytes: 100 * 1024 * 1024, files: 10, inlineChars: 64000, retentionMs: 30 * 24 * 60 * 60 * 1000 });
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TEXTY = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|toml|csv))/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|sh|bash|zsh|sql|log|diff|patch|env\.example)$/i;
const fail = (message, status = 400) => Object.assign(Error(message), { status });

export function safeName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return base || 'file';
}
const human = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

export function createUploads({ runtimeRoot, now = () => Date.now() }) {
  const root = path.join(runtimeRoot, 'grokbots-uploads');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  function prune() {
    for (const id of fs.readdirSync(root)) {
      if (!ID.test(id)) continue;
      try { const meta = JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8')); if (now() - meta.createdAt > UPLOAD_LIMITS.retentionMs) fs.rmSync(path.join(root, id), { recursive: true, force: true }); }
      catch { try { if (now() - fs.statSync(path.join(root, id)).mtimeMs > UPLOAD_LIMITS.retentionMs) fs.rmSync(path.join(root, id), { recursive: true, force: true }); } catch {} }
    }
  }
  try { prune(); } catch {}

  /** Streams one request body to disk; rejects past the per-file limit. */
  async function receive(req, { name, type }) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > UPLOAD_LIMITS.fileBytes) throw fail(`A file can be at most ${human(UPLOAD_LIMITS.fileBytes)}.`, 413);
    const id = randomUUID(), dir = path.join(root, id), file = safeName(name);
    fs.mkdirSync(dir, { mode: 0o700 });
    const target = path.join(dir, file), out = fs.openSync(target, 'wx', 0o600), hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > UPLOAD_LIMITS.fileBytes) throw fail(`A file can be at most ${human(UPLOAD_LIMITS.fileBytes)}.`, 413);
        hash.update(chunk); fs.writeSync(out, chunk);
      }
    } catch (error) { fs.closeSync(out); fs.rmSync(dir, { recursive: true, force: true }); throw error; }
    fs.closeSync(out);
    if (!size) { fs.rmSync(dir, { recursive: true, force: true }); throw fail('The file is empty.'); }
    const meta = { id, name: file, size, type: String(type || 'application/octet-stream').slice(0, 100), sha256: hash.digest('hex'), createdAt: now() };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    return { id, name: meta.name, size, type: meta.type };
  }
  function lookup(id) {
    if (!ID.test(String(id || ''))) throw fail('Invalid attachment.');
    let meta; try { meta = JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8')); } catch { throw fail('An attachment is no longer available. Remove it and attach the file again.', 410); }
    const file = path.join(root, id, safeName(meta.name));
    if (!fs.existsSync(file)) throw fail('An attachment is no longer available. Remove it and attach the file again.', 410);
    return { ...meta, path: file };
  }
  /**
   * Adds an attachments block to the text. Paths always; small text files are
   * inlined while the whole message stays within maxChars.
   */
  function compose(text, attachments, maxChars, { inline = true } = {}) {
    if (attachments === undefined || attachments === null) return text;
    if (!Array.isArray(attachments) || attachments.length > UPLOAD_LIMITS.files) throw fail(`At most ${UPLOAD_LIMITS.files} attachments per message.`);
    if (!attachments.length) return text;
    const files = attachments.map(a => lookup(a?.id));
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > UPLOAD_LIMITS.messageBytes) throw fail(`Attachments can total at most ${human(UPLOAD_LIMITS.messageBytes)} per message.`, 413);
    const lines = files.map(f => `- ${f.name} (${f.type}, ${human(f.size)}): ${f.path}`);
    let out = `${text ? text + '\n\n' : ''}[Attached files, saved on the Orbit host. Open them with your file tools.]\n${lines.join('\n')}`;
    if (out.length > maxChars) throw fail('The message and attachment list exceed the 100,000-character limit.');
    if (!inline) return out;
    let budget = Math.min(UPLOAD_LIMITS.inlineChars, maxChars - out.length);
    for (const f of files) {
      if (!(TEXTY.test(f.type) || TEXT_EXT.test(f.name)) || f.size > budget * 4) continue;
      let body; try { body = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
      if (body.includes('\u0000')) continue;
      const block = `\n\n--- ${f.name} ---\n${body}`;
      if (block.length > budget) continue;
      out += block; budget -= block.length;
    }
    return out;
  }
  return { receive, lookup, compose, prune, root };
}
