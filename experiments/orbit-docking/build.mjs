import { build } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] || '/tmp/opencode/orbit-docking-build');
if (!outDir.startsWith('/tmp/opencode/')) throw Error('Build output must be under /tmp/opencode/');
const dependency = '/tmp/opencode/orbit-docking-deps/node_modules/dockview-core';
if (JSON.parse(fs.readFileSync(`${dependency}/package.json`, 'utf8')).version !== '8.3.1') {
  throw Error('Run experiments/docking/setup.sh; exact dockview-core@8.3.1 required');
}
await build({
  configFile: false, root, base: './', publicDir: false,
  resolve: { alias: { 'dockview-core': `${dependency}/dist/package/main.esm.mjs` } },
  build: { outDir, emptyOutDir: true, sourcemap: true },
});
