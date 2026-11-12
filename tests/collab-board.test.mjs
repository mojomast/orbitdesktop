// Group-chat build tracking: board-only Collab projects, the collab-board op layer, and group prompt guidance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCollab } from '../server/collab.mjs';
import { createCollabBoard } from '../server/collab-board.mjs';
import { createSharedAgents } from '../server/shared-agents.mjs';

const WS = '12345678-1234-4234-9234-123456789abc';
const GID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('collab-board creates a board-only project, adds entries, check-ins and status moves, and never starts agent turns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  const turns = [];
  const gateways = new Proxy({}, { get: () => async (...a) => { turns.push(a); throw new Error('no agent turns on a tracking board'); } });
  const collab = createCollab({ directory: path.join(dir, 'collab'), gateways, advanceIntervalMs: 60000 });
  const operate = body => new Promise((resolve, reject) => collab.handle((_r, status, obj) => (status >= 400 ? reject(Object.assign(new Error(obj.error), { status })) : resolve(obj)), {}, body));
  const group = { id: GID, name: 'zz', members: [{ id: 'hermes' }, { id: 'pipi' }] };
  const groups = { find: id => (id === GID ? group : null), boardOf: () => group.board || null, linkBoard: (_id, link) => { group.board = link; } };
  const board = createCollabBoard({ runtimeRoot: dir, collab: () => operate, groups: () => groups, workspace: () => WS });
  try {
    assert.deepEqual((await board.op({ group: GID, op: 'list' })).entries, []);
    const made = await board.op({ group: GID, op: 'new', title: 'Pizza Panic', by: 'hermes', status: 'doing' });
    assert.ok(group.board.projectId, 'the group links to its board');
    const id = made.entry.id;
    await board.op({ group: GID, op: 'checkin', entry: id, note: 'testing in the pane', by: 'pipi' });
    await board.op({ group: GID, op: 'update', entry: id, status: 'done', note: 'shipped', by: 'pipi' });
    const list = await board.op({ group: GID, op: 'list' });
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0].status, 'completed');
    assert.equal(list.entries[0].checkins.at(-1).by, 'pipi');
    await assert.rejects(board.op({ group: GID, op: 'checkin', entry: id, note: 'x', by: 'stranger' }), /handle/);
    const st = await operate({ workspace_id: WS, project_id: group.board.projectId, operation: 'state' });
    assert.equal(st.project.status, 'tracking');
    await assert.rejects(operate({ workspace_id: WS, project_id: group.board.projectId, operation: 'resume' }), /tracking board/);
    assert.equal(turns.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('group prompts carry the board guidance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  const seen = [];
  const gateways = { async startSpeaker(a) { seen.push(a); return { runId: `run_${'1'.padStart(32, '0')}`, started: Date.now() }; }, async pollSpeaker() { return { status: 'completed', output: '(quiet)' }; }, async stopSpeaker() {} };
  const r = createSharedAgents({ directory: dir, gateways, members: [{ id: 'hermes', label: 'Hermes' }, { id: 'pipi', label: 'pipi' }], defaultResponder: 'hermes', guidance: 'Build tracking: ~/bin/collab-board GID list', advanceIntervalMs: 20 });
  try {
    await new Promise(res => r.handle(() => res(), {}, { workspace_id: '0b0b0b0b-0000-4000-8000-00000000c0de', pane_id: GID, operation: 'post', text: 'build a thing' }));
    for (let i = 0; i < 40 && !seen.length; i += 1) await new Promise(x => setTimeout(x, 25));
    assert.match(seen[0].prompt, /collab-board GID list/);
    assert.match(seen[0].instructions, /collab-board GID list/);
  } finally { r.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collab-board: finished entries do not count toward the cap and old ones auto-archive', async () => {
  process.env.ORBIT_BOARD_ACTIVE_MAX = '20'; process.env.ORBIT_BOARD_TOTAL_MAX = '60';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  const collab = createCollab({ directory: path.join(dir, 'collab'), gateways: {}, advanceIntervalMs: 60000 });
  const operate = body => new Promise((resolve, reject) => collab.handle((_r, status, obj) => (status >= 400 ? reject(Object.assign(new Error(obj.error), { status })) : resolve(obj)), {}, body));
  const group = { id: GID, name: 'zz', members: [{ id: 'hermes' }] };
  const groups = { find: id => (id === GID ? group : null), boardOf: () => group.board || null, linkBoard: (_id, link) => { group.board = link; } };
  const board = createCollabBoard({ runtimeRoot: dir, collab: () => operate, groups: () => groups, workspace: () => WS });
  try {
    for (let i = 0; i < 80; i += 1) {
      const e = await board.op({ group: GID, op: 'new', title: `t${i}`, by: 'hermes' });
      if (i < 70) await board.op({ group: GID, op: 'update', entry: e.entry.id, status: 'done', by: 'hermes' });
    }
    const list = await board.op({ group: GID, op: 'list' });
    assert.equal(list.entries.filter(e => e.status !== 'completed').length, 10);
    assert.ok(list.entries.filter(e => e.status === 'completed').length <= 50);
    const st = await operate({ workspace_id: WS, project_id: group.board.projectId, operation: 'state' });
    assert.ok(st.tasks.length <= 60);
    for (let i = 0; i < 10; i += 1) await board.op({ group: GID, op: 'new', title: `open${i}`, by: 'hermes' });
    await assert.rejects(board.op({ group: GID, op: 'new', title: 'one too many', by: 'hermes' }), /20 open entries/);
  } finally { delete process.env.ORBIT_BOARD_ACTIVE_MAX; delete process.env.ORBIT_BOARD_TOTAL_MAX; fs.rmSync(dir, { recursive: true, force: true }); }
});
