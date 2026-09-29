import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceFetch} from '../src/workspace-client.ts';

test('workspace reads carry no mutation metadata; sync carries one identity and its base revision', async t => {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({url, body: JSON.parse(init.body)});
    return new Response(JSON.stringify({revision: 4}), {status: 200});
  };
  await workspaceFetch('owner', {workspace_id: 'w', action: 'read', observed_revision: 4});
  await workspaceFetch('owner', {workspace_id: 'w', action: 'sync', observed_revision: 4, base_revision: 4, state: {}, intent: 'Synchronize browser workspace changes'});
  assert.deepEqual(calls[0].body, {workspace_id: 'w', action: 'read', observed_revision: 4});
  assert.equal(calls[1].body.base_revision, 4);
  assert.match(calls[1].body.operation_id, /^[a-f0-9-]{36}$/);
  assert.equal(calls[1].body.intent, 'Synchronize browser workspace changes');
});

test('checkpoint reads revision first, and a failed read never issues the mutation', async t => {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({url, body: JSON.parse(init.body)});
    return new Response(JSON.stringify({revision: 7}), {status: 200});
  };
  await workspaceFetch('owner', {workspace_id: 'w', action: 'checkpoint', label: 'Before theme', intent: 'Save checkpoint before theme'}, '/api/workspace/recovery');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.action, 'read');
  assert.equal(calls[1].body.base_revision, 7);
  assert.equal(calls[1].url, '/api/workspace/recovery');
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({error: 'unavailable'}), {status: 503});
  };
  const response = await workspaceFetch('owner', {workspace_id: 'w', action: 'checkpoint'});
  assert.equal(response.status, 503);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'read');
});

test('non-checkpoint mutations require a base revision and never retry uncertain fetch errors', async t => {
  let calls = 0;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { calls++; throw Error('network lost'); };
  await assert.rejects(workspaceFetch('owner', {workspace_id: 'w', action: 'restore'}), /revision/);
  assert.equal(calls, 0);
  await assert.rejects(workspaceFetch('owner', {workspace_id: 'w', action: 'restore', base_revision: 3,operation_id:'chosen-key',intent:'Restore reviewed snapshot'}), error=>/outcome unknown/.test(error.message)&&error.operation_id==='chosen-key'&&error.base_revision===3);
  assert.equal(calls, 1);
});
