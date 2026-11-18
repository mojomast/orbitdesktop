import assert from 'node:assert/strict';
import test from 'node:test';
import { controlsFor, renderRelease } from '../apps/rizzstack-hive/operations.js';
import { release } from '../apps/rizzstack-hive/release.js';

const scope = {kind: 'attempt', id: 'att-8'};
const rails = {openRails() { assert.fail('discovery must not invoke a provider'); }};
const context = {selection: scope, record: {...scope, stage: 'verify'}, mode: 'host', connected: true, providers: {rails}};
const available = ctx => controlsFor(ctx).filter(row => row.available);

test('a connected host navigation handle is necessary but not sufficient: the selector must match', () => {
  const [nav] = available(context);
  assert.deepEqual(nav.target, scope);
  assert.equal(nav.kind, 'navigation');
  for (const changed of [{mode: 'replay'}, {mode: 'shift'}, {connected: false}, {connected: 'true'},
    {providers: {}}, {providers: {openRails: rails.openRails}}, {providers: {rails: true}},
    {providers: Object.create({rails})}, {record: null}, {record: {id: 'other'}},
    {selection: {kind: 'attempt', id: '../x'}, record: {id: '../x'}}]) {
    assert.deepEqual(available({...context, ...changed}), []);
  }
  const task = {kind:'task', id:'task:j-5:t-9', jobId:'j-5', stage:'build'};
  assert.deepEqual(available({...context, selection:task, record:task})[0].target, {kind:'job', id:'j-5'});
  assert.deepEqual(available({...context, selection:task, record:{...task, jobId:null}}), []);
});

test('a connected host plus arbitrary supplied write providers never makes an operation executable', () => {
  const denied = new Set();
  const providers = new Proxy({rails}, {get: () => () => assert.fail('provider invoked')});
  for (const stage of ['auth', 'dispatch', 'build', 'verify', 'review', 'integrate', 'deploy', 'receiver']) {
    for (const kind of ['station','backlog']) {
      const sel = {kind, id:stage};
      const rows = controlsFor({...context, providers, selection:sel, record:{...sel, stage, role:'owner', ready:true}});
      assert.ok(rows.length > 0);
      for (const r of rows) {
        assert.equal(r.available, false); assert.equal(r.kind, 'write');
        assert.ok(r.label && r.reason && r.next); assert.ok(!Object.values(r).some(v => typeof v === 'function'));
        denied.add(r.id);
      }
    }
  }
  for (const id of ['retry','verify','dispatch','reconcile','decision','merge','promote','deploy','rollback']) assert.ok(denied.has(id));
});

function ledger() {
  const doc = {createElement(tag) {return {tag, ownerDocument:doc, children:[], textContent:'',
    append(...els) { this.children.push(...els); }, replaceChildren(...els) { this.children = els; }};}};
  const root = doc.createElement('section'); renderRelease(root);
  const walk = n => [n, ...n.children.flatMap(walk)];
  const text = n => walk(n).map(el => el.textContent).filter(Boolean).join(' ');
  const all = walk(root);
  const rows = new Map(all.filter(n => n.tag === 'tr' && n.children[0].scope === 'row').map(n => [text(n.children[0]), n.children.slice(1).map(text)]));
  return {all, rows};
}
test('release ledger never substitutes main, PR or integration refs for the qualified component tuple', () => {
  const {all, rows} = ledger();
  assert.match(all.find(n => n.tag === 'h2').textContent, /release HOLD/);
  const [qualified] = rows.get('Qualified candidate tuple');
  for (const sha of Object.values(release.tuple)) assert.ok(qualified.includes(sha));
  const [pr, cliAt] = rows.get('PR heads & merge state');
  assert.match(pr, /433dfa1f6ae7ada071d3ccfb0056b8a0e13b2aa0/); assert.ok(!qualified.includes('433dfa1f6a'));
  assert.match(cliAt, /2026-11-18 .* UTC/);
  const [main] = rows.get('Current main');
  assert.match(main, /not live/); assert.match(main, /4ed25529cc18e32e5c0161bc538aae086ae5eb89/);
  const [integration] = rows.get('Integration head');
  assert.match(integration, /fixture\/r18/); assert.match(integration, /f2c1f30980d7c001a2402aa316f20f03b0a3e08b/);
  for (const field of [qualified, pr, main]) assert.ok(!field.includes('f2c1f309'));
  assert.match(rows.get('Component CI')[1], new RegExp(release.at.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
test('release gates each carry evidence, currentness and a next step; missing runtime receipts never count as passes', () => {
  const {all, rows} = ledger();
  for (const [name, [finding, basis, next]] of rows) assert.ok(finding && basis && next, name);
  for (const [name, pattern] of [['Required software cases', /665 passed/], ['Native Windows CI', /Passed on runner/],
    ['Live Windows canary', /Blocked · not run/], ['Worker attribution', /Unproven/], ['Human receiver', /pending/],
    ['Native RETURN', /6058fa382132dfb7/], ['Rails evidence sidecar', /0701a07bdd501036/],
    ['Authenticated HTTP p95', /1614\.091.*525\.956.*499\.716.*189\.422.*670\.749/],
    ['Historical-state compatibility', /Unverified/], ['Installed revisions', /Unknown/], ['Loaded revisions', /unverified/],
    ['Rollback readiness', /Unrehearsed/], ['Owner promotion', /Withheld/]]) assert.match(rows.get(name)[0], pattern);
  for (const a of all.filter(n => n.tag === 'a')) {
    assert.match(a.href, /^https:\/\/github\.com\/mojomast\/(workflow|bundlebees|hyvv|orbitdesktop)\/(blob|commit)\/[a-f0-9]{40}(?:\/|$)/);
    assert.equal(a.rel, 'noopener noreferrer');
  }
});
