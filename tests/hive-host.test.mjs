import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('the owner-read grant only recognizes the reviewed publisher output', () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'hive-entry-'));
  try {
    const manifest = JSON.parse(execFileSync('python3', ['scripts/plugin_publish.py', 'apps/rizzstack-hive',
      '--id', 'rizzstack-hive', '--version', '1.0.0', '--title', 'The Hive', '--runtime', runtime], {encoding:'utf8'}));
    const source = readFileSync('src/hive-host.ts','utf8');
    assert.equal(source.match(/const HIVE_ENTRY = '([^']+)'/)?.[1], manifest.entry,
      'review the static bundle and explicitly update the trusted entry after a change');
  } finally { rmSync(runtime,{recursive:true,force:true}); }
});
