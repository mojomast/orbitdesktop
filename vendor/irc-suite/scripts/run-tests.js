// Finds packages/*/test/**/*.test.js and integration/**/*.test.js and runs them with node --test.
// Node 18 has no glob support in --test, so we expand the file list here.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.test.js')) files.push(p);
  }
}
const pkgs = join(root, 'packages');
if (existsSync(pkgs)) for (const pkg of readdirSync(pkgs)) walk(join(pkgs, pkg, 'test'));
walk(join(root, 'integration'));
files.sort();
// A green run must mean tests actually ran: discovering nothing is a failure, not a pass.
if (files.length === 0) {
  console.error('no test files found - the root test command must run real tests, failing');
  process.exit(1);
}
console.log(`running ${files.length} test file(s)`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
