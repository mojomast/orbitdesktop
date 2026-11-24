import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const upstreamHead = '5982efe845f99528b2facde08991d951269ec4ab';
export const adminFixture = 'test/integration/admin-endpoints.test.ts';
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, {cwd, encoding:'utf8'}).trim();

// This pinned integration test configures every catalog except OpenCode Zen
// (always active). Serve one supported Zen model on its disposable loopback
// upstream and check it appears in the refresh; keep every upstream assertion and
// production byte, and leave the provisioned checkout untouched.
export function cloneOfflineRouteTok(upstream, destination) {
  assert.equal(git(upstream, 'rev-parse', 'HEAD'), upstreamHead);
  assert.equal(git(upstream, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(upstream, 'node_modules')), false);
  git(upstream, 'clone', '--no-hardlinks', '--quiet', '--', upstream, destination);
  git(destination, 'checkout', '--detach', '--quiet', upstreamHead);
  assert.equal(git(destination, 'status', '--porcelain'), '');
  const file = path.join(destination, adminFixture);
  const original = fs.readFileSync(file, 'utf8');
  assert.equal(createHash('sha256').update(original).digest('hex'), 'ce02fa59a26b9b9524085a8dcfa58a2ce5e65cf236ebfabe1d642946a3ac37b2');
  const patch = fileURLToPath(new URL('./routetok-offline-catalog.patch', import.meta.url));
  git(destination, 'apply', '--check', patch);
  git(destination, 'apply', patch);
  assert.equal(git(destination, 'diff', '--name-only'), adminFixture);
  return fs.readFileSync(file, 'utf8');
}
