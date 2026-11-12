// Built-in Orbit apps shipped in the repo under apps/<slug>/ and installed into
// the runtime bundle directory (<runtime>/apps/<slug>/) on server start.
//
// Install rules (idempotent, never clobbers local work):
//   - not installed            -> install
//   - installed bytes identical -> nothing
//   - installed carries an older `orbit-builtin-app` version marker, or is a
//     known earlier shipped build (legacyDigests) -> upgrade, keeping the old
//     copy in <slug>.previous/
//   - anything else (newer marker, or unmarked local edits) -> leave it alone
// Must run before the bundle registry refresh (createWorkspaceService) so the
// installed bundle is indexed on the same start.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const builtinAppsRoot = fileURLToPath(new URL('../apps/', import.meta.url));

export const BUILTIN_APPS = [
  // Grok Bots (multi-agent chat). Legacy digest: the unmarked build that ran live
  // before the app was committed (byte-identical apart from the version marker).
  { slug: 'grokbots', legacyDigests: ['39681786060ae7f6a1607fa4465bc6a095274aee7cb953c752d4bbcefb8e06e8'] },
];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MARKER = /<meta\s+name="orbit-builtin-app"\s+content="([a-z0-9-]+)@(\d+)"/i;

export function builtinVersion(html, slug) {
  const m = MARKER.exec(String(html).slice(0, 4096));
  return m && m[1] === slug ? Number(m[2]) : null;
}

function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

export function installBuiltinApps({ runtimeRoot, sourceRoot = builtinAppsRoot, apps = BUILTIN_APPS, log = () => {} } = {}) {
  const appsDir = path.join(runtimeRoot, 'apps');
  fs.mkdirSync(appsDir, { recursive: true, mode: 0o700 });
  const results = [];
  for (const app of apps) {
    const { slug } = app;
    try {
      const src = path.join(sourceRoot, slug);
      const srcIndex = fs.readFileSync(path.join(src, 'index.html'));
      const shipped = builtinVersion(srcIndex, slug);
      if (shipped == null) throw Error('shipped index.html has no orbit-builtin-app marker');
      const dest = path.join(appsDir, slug);
      let installed = null;
      try { const st = fs.lstatSync(dest); if (st.isSymbolicLink() || !st.isDirectory()) { results.push({ slug, action: 'skipped', reason: 'destination is not a plain directory' }); continue; } installed = fs.readFileSync(path.join(dest, 'index.html')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const files = listFiles(src);
      if (installed) {
        const same = files.every(rel => { try { return sha256(fs.readFileSync(path.join(dest, rel))) === sha256(fs.readFileSync(path.join(src, rel))); } catch { return false; } });
        if (same) { results.push({ slug, action: 'current', version: shipped }); continue; }
        const have = builtinVersion(installed, slug);
        const legacy = have == null && (app.legacyDigests || []).includes(sha256(installed));
        if (!(legacy || (have != null && have < shipped))) { results.push({ slug, action: 'kept', version: have, shipped, reason: have == null ? 'installed copy has local edits' : 'installed copy is the same or newer version' }); continue; }
      }
      // Stage in a hidden sibling (ignored by the bundle registry), then swap in.
      const stage = path.join(appsDir, `.${slug}.install-${process.pid}-${Date.now()}`);
      fs.rmSync(stage, { recursive: true, force: true });
      for (const rel of files) { fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true, mode: 0o755 }); fs.copyFileSync(path.join(src, rel), path.join(stage, rel)); }
      fs.chmodSync(stage, 0o755);
      if (installed) { const prev = path.join(appsDir, `${slug}.previous`); fs.rmSync(prev, { recursive: true, force: true }); fs.renameSync(dest, prev); }
      fs.renameSync(stage, dest);
      results.push({ slug, action: installed ? 'upgraded' : 'installed', version: shipped });
    } catch (error) {
      results.push({ slug, action: 'failed', reason: String(error?.message || error).slice(0, 200) });
    }
  }
  for (const r of results) if (r.action !== 'current') log(`Built-in app ${r.slug}: ${r.action}${r.reason ? ` (${r.reason})` : ''}`);
  return results;
}
