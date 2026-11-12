import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalWorkers } from '../server/local-workers.mjs';

test('archive moves only old terminal, non-excluded attempts, oldest first, to target', () => {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'lw-arch-'));
  const dir = path.join(runtimeDir, 'local-workers'); mkdirSync(dir, { recursive: true });
  const NOW = Date.parse('2026-10-23T12:00:00Z'); const iso = (h) => new Date(NOW - h * 3600e3).toISOString();
  const at = {}; const add = (id, state, h) => { at[id] = { attempt_id: id, state, created_at: iso(h), ended_at: iso(h), history: [] }; };
  add('old1', 'accepted', 100); add('old2', 'failed', 90); add('old3', 'cancelled', 80); add('ex', 'rejected', 200);
  add('run', 'running', 300); add('q', 'queued', 300); add('cr', 'cancel_requested', 300); add('new', 'succeeded', 2);
  writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ version: 1, attempts: at }));
  const lw = createLocalWorkers({ runtimeDir, launcherUrl: 'http://127.0.0.1:1', launcherToken: 'x', board: { update: async () => {} }, now: () => NOW });
  const r = lw.archive({ target: 6, exclude: ['ex'] });
  assert.equal(r.archived, 2); assert.equal(r.total, 6);
  const ids = lw.list().map((a) => a.attempt_id).sort();
  assert.deepEqual(ids, ['cr', 'ex', 'new', 'old3', 'q', 'run']);
  assert.equal(Object.keys(JSON.parse(readFileSync(path.join(dir, 'ledger.json'))).attempts).length, 6);
  const f = readdirSync(dir).find((n) => n.startsWith('archive-') && n.endsWith('.json'));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(dir, f))).attempts).sort(), ['old1', 'old2']);
  assert.equal(lw.archive({ target: 0, exclude: ['ex'] }).total, 5);
});
