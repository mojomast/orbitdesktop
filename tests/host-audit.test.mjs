import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostAudit, redactAuditText } from '../server/host-audit.mjs';

function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-host-audit-'));
  return { root, cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}

function entry(overrides = {}) {
  return {
    time: '2026-11-12T00:00:00.000Z',
    agent: 'setup',
    host: 'build-01',
    argv: ['uptime'],
    approvalId: null,
    exitCode: 0,
    durationMs: 12,
    outputBytes: 24,
    outputTail: 'up 10 days',
    ...overrides,
  };
}

test('audit appends JSONL at 0600 in a 0700 directory and verifies the hash chain', () => {
  const box = tempRuntime();
  try {
    const audit = createHostAudit({ runtimeDir: box.root, now: () => Date.parse('2026-11-12T00:00:00.000Z') });
    audit.append(entry());
    audit.append(entry({ argv: ['docker', 'ps'], exitCode: 0, outputTail: 'one container' }));
    audit.append(entry({ argv: ['false'], exitCode: 1, outputTail: '' }));

    const file = audit.fileFor('build-01');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

    const read = audit.read('build-01');
    assert.equal(read.valid, true);
    assert.equal(read.entries.length, 3);
    assert.equal(read.entries[0].prev_sha256, '0'.repeat(64));
    assert.equal(read.entries[1].prev_sha256, read.entries[0].sha256);
    assert.equal(read.entries[2].prev_sha256, read.entries[1].sha256);
    assert.match(read.head, /^[a-f0-9]{64}$/);
  } finally {
    box.cleanup();
  }
});

test('audit is append-only across reopen and the chain continues', () => {
  const box = tempRuntime();
  try {
    const first = createHostAudit({ runtimeDir: box.root });
    first.append(entry());
    const before = first.read('build-01');
    first.append(entry({ argv: ['date'] }));
    const reopened = createHostAudit({ runtimeDir: box.root });
    const after = reopened.read('build-01');
    assert.equal(after.valid, true);
    assert.equal(after.entries.length, 2);
    assert.equal(after.entries[1].prev_sha256, before.head);
  } finally {
    box.cleanup();
  }
});

test('audit detects a tampered line and reports where the chain broke', () => {
  const box = tempRuntime();
  try {
    const audit = createHostAudit({ runtimeDir: box.root });
    audit.append(entry());
    audit.append(entry({ argv: ['docker', 'ps'] }));
    audit.append(entry({ argv: ['date'] }));
    const file = audit.fileFor('build-01');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const middle = JSON.parse(lines[1]);
    middle.argv = ['rm', '-rf', '/'];
    lines[1] = JSON.stringify(middle);
    fs.writeFileSync(file, lines.join('\n'));

    const read = audit.read('build-01');
    assert.equal(read.valid, false);
    assert.equal(read.brokenAt, 1);
    assert.ok(read.error);
  } finally {
    box.cleanup();
  }
});

test('audit redacts secrets in argv and output tails before writing', () => {
  const box = tempRuntime();
  try {
    const audit = createHostAudit({ runtimeDir: box.root });
    audit.append(entry({
      argv: ['deploy', '--token=super-secret-token', 'PASSWORD=hunter2', 'Authorization: Bearer abcdef123456'],
      outputTail: 'ORBIT_PAIRING_CODE=PAIR-SECRET -----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY----- tcABCDEFGHIJKLMNOP',
    }));
    const raw = fs.readFileSync(audit.fileFor('build-01'), 'utf8');
    assert.equal(raw.includes('super-secret-token'), false);
    assert.equal(raw.includes('hunter2'), false);
    assert.equal(raw.includes('abcdef123456'), false);
    assert.equal(raw.includes('PAIR-SECRET'), false);
    assert.equal(raw.includes('OPENSSH PRIVATE KEY-----\nAAAA'), false);
    assert.equal(raw.includes('tcABCDEFGHIJKLMNOP'), false);
    const read = audit.read('build-01');
    assert.equal(read.valid, true);
    assert.equal(JSON.stringify(read.entries).includes('super-secret-token'), false);
  } finally {
    box.cleanup();
  }
});

test('audit rejects host ids that escape the audit directory', () => {
  const box = tempRuntime();
  try {
    const audit = createHostAudit({ runtimeDir: box.root });
    for (const host of ['../escape', 'a/b', '..', '.', '', 'a\u0000b']) {
      assert.throws(() => audit.append(entry({ host })), /invalid/i);
    }
    assert.equal(fs.existsSync(path.join(box.root, 'audit', 'escape.jsonl')), false);
  } finally {
    box.cleanup();
  }
});

test('audit read reports a clean empty log for a host with no commands', () => {
  const box = tempRuntime();
  try {
    const audit = createHostAudit({ runtimeDir: box.root });
    const read = audit.read('never-used');
    assert.equal(read.valid, true);
    assert.deepEqual(read.entries, []);
    assert.equal(audit.read('never-used').head, null);
  } finally {
    box.cleanup();
  }
});

test('standalone redaction keeps ordinary text readable', () => {
  const text = redactAuditText('docker ps --format {{.Names}} ok');
  assert.equal(text, 'docker ps --format {{.Names}} ok');
  assert.equal(redactAuditText('--password=x'), '--password=[redacted]');
});
