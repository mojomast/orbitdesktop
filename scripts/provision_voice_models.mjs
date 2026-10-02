import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { VOICE_MODEL, VOICE_REVISION, VOICE_FILES, verifyVoiceBytes, assertNoSymlinks, readPinnedVoiceFile } from '../server/voice-model-assets.mjs';

async function safeDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing symlink/non-directory model path');
  }
}

export async function provisionVoiceModels({ modelsRoot, fetchFile = url => fetch(url) }) {
  const report = { model: VOICE_MODEL, revision: VOICE_REVISION, files: [] };
  for (const [file, expected] of Object.entries(VOICE_FILES)) {
    const target = path.join(path.resolve(modelsRoot), VOICE_MODEL, 'resolve', VOICE_REVISION, file);
    await safeDirectory(path.dirname(target));
    let existing = false;
    try {
      await readPinnedVoiceFile(target, expected);
      existing = true;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!existing) {
      const response = await fetchFile(`https://huggingface.co/${VOICE_MODEL}/resolve/${VOICE_REVISION}/${file}?download=true`);
      if (!response.ok) throw new Error(`Download failed (${response.status}): ${file}`);
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > expected[0]) throw new Error(`Download too large: ${file}`);
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (!verifyVoiceBytes(bytes, expected)) throw new Error(`Downloaded checksum mismatch: ${file}`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes); await handle.sync(); await handle.close();
        await assertNoSymlinks(path.dirname(target));
        try { await lstat(target); throw new Error('Model destination appeared during provisioning'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await rename(temporary, target);
        const dir = await open(path.dirname(target), 'r'); try { await dir.sync(); } finally { await dir.close(); }
      } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
    }
    report.files.push({ file, bytes: expected[0], sha256: expected[1], existing });
  }
  return report;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--models-root') throw new Error('Usage: node scripts/provision_voice_models.mjs --models-root <explicit-directory>');
  console.log(JSON.stringify(await provisionVoiceModels({ modelsRoot: args[1] }), null, 2));
}
