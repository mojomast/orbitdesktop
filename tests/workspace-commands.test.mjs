import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceCommands } from '../src/workspace-commands.ts';

test('command execution rechecks live availability after discovery', async () => {
  let enabled = true, connected = true, count = 0;
  const reports = [];
  const commands = createWorkspaceCommands(() => [{ id: 'tool', title: 'Tool', detail: 'Inspect', group: 'Workspace',
    hidden: !enabled, disabledReason: connected ? undefined : 'Connect host first', run: () => { count++; } }], message => reports.push(message));
  assert.equal(commands.list().length, 1);
  connected = false;
  await commands.execute('tool');
  assert.equal(count, 0);
  assert.deepEqual(reports, ['Connect host first']);
  connected = true;
  enabled = false;
  await commands.execute('tool');
  assert.equal(count, 0);
  enabled = true;
  await commands.execute('tool');
  assert.equal(count, 1);
});

test('multiword search discovers metadata and asynchronous failures are reported', async () => {
  const reports = [];
  const commands = createWorkspaceCommands(() => [{ id: 'broken', title: 'Workspace checkpoints', detail: 'Restore saved state',
    group: 'Recovery', keywords: ['history'], run: async () => { throw Error('offline'); } }], message => reports.push(message));
  assert.equal(commands.list('history recovery')[0]?.id, 'broken');
  assert.equal(commands.list('history unknown').length, 0);
  await commands.execute('broken');
  assert.match(reports[0], /Workspace checkpoints could not open: Error: offline/);
});

test('an exact command name outranks earlier incidental description matches', () => {
  const commands = createWorkspaceCommands(() => [
    {id:'saved',title:'Saved workspace layouts',detail:'Reusable window arrangements',group:'Layout',run(){}},
    {id:'arrange',title:'Arrange workspace',detail:'Arrange current windows',group:'Layout',run(){}},
    {id:'arrange-extra',title:'Arrange workspace presets',detail:'Manage presets',group:'Layout',run(){}},
  ], () => {});
  assert.deepEqual(commands.list().map(c=>c.id), ['saved','arrange','arrange-extra']);
  assert.deepEqual(commands.list('  ARRANGE   workspace ').map(c=>c.id), ['arrange','arrange-extra','saved']);
});
