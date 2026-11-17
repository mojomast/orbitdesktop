import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './fixtures/local-orbit.mjs';
import { makeFixture, snapshot } from './fixtures/acdd-board.mjs';
import { projectEvidence } from '../src/collab-evidence.ts';
import { renderEvidencePanel } from '../src/acdd-evidence-panel.ts';

test('real Orbit evidence GET projects only signed matching records into the chip, panel and feed', async t => {
  const { root,ref } = makeFixture(t);
  const before = snapshot(root);
  const app = await boot(t,{ORBIT_ACDD_STATE_DIR:root});
  const route = `/api/acdd-evidence?contract=${ref.id}&sha=${ref.contract_sha256}`;
  const read = (headers={}) => app.call('GET',route,undefined,{Origin:app.base,...headers});
  assert.equal((await read({Authorization:''})).status,403);
  assert.equal((await read({Origin:'https://foreign.invalid'})).status,403);
  for (const [site,referrer,expected] of [['cross-site',app.base,403],['same-origin','https://foreign.invalid',403],['same-origin',app.base,200]]) {
    assert.equal((await app.call('GET',route,undefined,{'Sec-Fetch-Site':site,Referer:referrer})).status,expected);
  }
  assert.equal((await app.call('POST',route,{})).status,405);
  const {status,data} = await read(); assert.equal(status,200);
  const {chip,rows,state} = projectEvidence(ref,data);
  assert.equal(chip,'ACDD integration: integration_failed'); assert.equal(state,'error');
  assert.deepEqual(rows.slice(0,4).map(row=>row.text.split(':')[0]), ['red','green','refactor','integration']);
  for (const code of ['scope_violation','tests_tampered','integration_failed']) assert.ok(rows.some(row => row.state === 'error' && row.text.includes(code)),code);
  assert.ok(rows.some(row => row.state === 'pending' && row.text.includes('unrun')));
  assert.match(renderEvidencePanel(data.view), /acdd-status-not-run[^]*?Not run/);
  assert.equal(projectEvidence({...ref,contract_sha256:'b'.repeat(64)},data).state,'pending');
  assert.equal((await app.call('GET',route.replace(ref.contract_sha256,'b'.repeat(64)),undefined,{Origin:app.base})).status,404);
  assert.deepEqual(snapshot(root),before);
});
