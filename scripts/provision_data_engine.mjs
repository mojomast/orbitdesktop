import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DATA_ENGINE_FILES, DATA_ENGINE_VERSION, DATA_ENGINE_PLATFORM, assertDataEnginePath, verifyDataEngineBytes } from '../server/data-engine-assets.mjs';

function safeDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Refusing symlink/non-directory DuckDB asset path');
  }
}
export async function provisionDataEngine({ extensionsRoot = '.runtime/engines/duckdb', fetchFile = url => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) }) } = {}) {
  const directory = path.join(path.resolve(extensionsRoot), DATA_ENGINE_VERSION, DATA_ENGINE_PLATFORM);
  safeDirectory(directory);
  const report = { engineVersion: DATA_ENGINE_VERSION, platform: DATA_ENGINE_PLATFORM, extensionsRoot: path.resolve(extensionsRoot), files: [] };
  for (const [kind, expected] of Object.entries(DATA_ENGINE_FILES)) {
    const target = path.join(directory, expected.file);
    let existing = false;
    try {
      assertDataEnginePath(target);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.size !== expected.bytes || !verifyDataEngineBytes(fs.readFileSync(target), expected)) throw Error(`Existing ${kind} extension has invalid size/checksum; refusing replacement`);
      existing = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing) {
      const url = `https://extensions.duckdb.org/${DATA_ENGINE_VERSION}/${DATA_ENGINE_PLATFORM}/${expected.file}`;
      const response = await fetchFile(url);
      if (!response.ok || !response.body) throw Error(`Extension provisioning failed (${response.status}): ${kind}`);
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > expected.bytes) throw Error(`Extension download too large: ${kind}`);
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (!verifyDataEngineBytes(bytes, expected)) throw Error(`Extension download checksum mismatch: ${kind}`);
      assertDataEnginePath(directory);
      const temporary = path.join(directory, `.provision-${randomUUID()}`);
      let fd;
      try {
        fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        assertDataEnginePath(directory);
        try { fs.lstatSync(target); throw Error('Extension destination appeared during provisioning'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.renameSync(temporary, target);
        const d = fs.openSync(directory, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
      } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
    }
    report.files.push({ kind, ...expected, existing });
  }
  return report;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--extensions-root' || !args[1])) throw Error('Usage: node scripts/provision_data_engine.mjs [--extensions-root <private-directory>]');
  console.log(JSON.stringify(await provisionDataEngine({ extensionsRoot: args[1] }), null, 2));
}
