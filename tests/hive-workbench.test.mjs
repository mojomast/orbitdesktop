import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createWorkbench } from '../apps/rizzstack-hive/workbench.js';
import { project } from '../apps/rizzstack-hive/snapshot-adapter.js';
import { fixtureTime, fixtures } from '../apps/rizzstack-hive/fixtures.js';

// Native DOM behaviour (reflow, AX and Playwright navigation) is covered by
// the browser gates; this small host exercises the controller without Chrome.
class Node extends EventTarget {
  constructor(tag, doc) { super(); this.tagName = tag; this.ownerDocument = doc; }
  children = []; dataset = {}; attributes = {}; value = ''; ownText = ''; className = '';
  classList = { add: s => { this.className += ' ' + s; } };
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  get firstElementChild() { return this.children[0]; }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(' '); }
  set textContent(s) { this.replaceChildren(); this.ownText = String(s); }
  set innerHTML(_) { throw new Error('HTML input is forbidden'); }
  contains(n) { return n === this || this.children.some(c => c.contains(n)); }
  remove() {
    if (!this.parentNode) return;
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
    const a = this.parentNode.children; a.splice(a.indexOf(this), 1); this.parentNode = null;
  }
  insertBefore(n, before) { n.remove(); n.parentNode = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, n); }
  append(...nodes) { nodes.forEach(n => this.insertBefore(n)); }
  replaceChildren(...nodes) { [...this.children].forEach(n => n.remove()); this.ownText = ''; this.append(...nodes); }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  closest(s) { assert.equal(s, '[hidden]'); return this.hidden ? this : this.parentNode?.closest(s); }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
}
const observed = name => project(fixtures[name], { now: fixtureTime });
function setup() {
  const doc = { createElement: tag => new Node(tag, doc) }, picks = [], actions = [];
  const work = doc.createElement('section'), shift = doc.createElement('section');
  const desk = createWorkbench({ root: work, shift, onChoose: s => picks.push(s), onRelease: () => actions.push('release') });
  const find = fn => [...work.walk()].find(fn), id = key => find(n => n.id === key);
  const rows = () => id('rows').children.map(n => n.firstElementChild);
  const tab = name => find(n => n.getAttribute('role') === 'tab' && n.textContent === name);
  const field = (idKey, value, event) => { const n = id(idKey); n.value = value; n.dispatchEvent(new Event(event)); };
  return { doc, work, shift, picks, actions, desk, find, id, rows, tab, field };
}

test('scope select and roving tabs lead to the same projected row and selection', () => {
  const h = setup(), v = observed('shift'); h.desk.update(v, { demo: true });
  assert.equal(h.tab('Work').getAttribute('aria-selected'), 'true');
  assert.equal(h.rows().length, v.records.filter(r => r.kind === 'job').length);
  assert.doesNotMatch(h.work.textContent, /reconciliation suggestion/);
  const e = new Event('keydown', { cancelable: true }); Object.defineProperty(e, 'key', { value: 'ArrowRight' }); h.tab('Work').dispatchEvent(e);
  assert.equal(h.doc.activeElement, h.tab('Workers'));
  assert.equal(h.id('scope').value, 'attempt');
  assert.equal(h.id(h.tab('Workers').getAttribute('aria-controls')).hidden, false);
  assert.equal(h.rows().length, v.attempts.length);
  h.field('scope', 'ci', 'change'); assert.equal(h.tab('Evidence').tabIndex, 0);
  assert.equal(h.rows().length, v.records.filter(r => r.kind === 'ci').length);
  h.rows()[0].click(); assert.deepEqual(h.picks.pop(), { kind: 'ci', id: v.records.find(r => r.kind === 'ci').id });
  const link = h.find(n => n.tagName === 'button' && n.textContent.startsWith('Open release dossier'));
  link.click(); assert.deepEqual(h.actions, ['release']);
  h.desk.restoreFocus(); assert.equal(h.doc.activeElement, link);
});

test('the shift ledger includes reported tasks, active and recent attempts, and exact observation times', () => {
  const h = setup(), v = observed('dense'); h.desk.update(v);
  const picks = [...h.shift.walk()].filter(n => n.tagName === 'button');
  assert.equal(picks.length, 6); assert.match(h.shift.textContent, /14 in flight/);
  assert.match(h.shift.textContent, /Recent record/); assert.match(h.shift.textContent, /6 of \d+ public attempts shown/);
  const a = v.attempts[0];
  for (const s of [a.detail || a.taskId, a.id, a.route, a.state, a.at.slice(11, 19), a.jobId]) assert.ok(picks[0].textContent.toLowerCase().includes(s.toLowerCase()));
  picks[0].click(); assert.deepEqual(h.picks.pop(), { kind: 'attempt', id: a.id });
  h.desk.restoreFocus(); assert.equal(h.doc.activeElement, picks[0]);
  h.desk.update(v, { historical: true }); assert.match(h.shift.textContent, /Last observed assignments.*In flight unknown/s);
  assert.doesNotMatch(h.shift.textContent, /\bActive\b|14 in flight/);
  h.desk.update(observed('quiet')); assert.match(h.shift.textContent, /0 in flight/);
  h.desk.update(observed('degraded')); assert.match(h.shift.textContent, /In flight unknown/);
});

test('bounded paging, sort, search and return focus survive refresh; reset removes stale data and targets', () => {
  const h = setup(), v = observed('shift');
  const attempts = Array.from({ length: 69 }, (_, i) => ({ ...v.attempts[0], id: 'r-' + i, taskId: 'task-' + i, route: i % 2 ? 'east' : 'west', detail: null }));
  const view = { ...v, attempts }; h.desk.update(view); h.desk.setScope('attempt');
  assert.ok(h.rows().length < attempts.length); h.id('more').click();
  assert.equal(h.doc.activeElement, h.rows()[0]);
  h.field('search', 'WeSt', 'input'); assert.match(h.id('result-count').textContent, /1–\d+ of 35/);
  h.field('hw-sort', 'name', 'change'); assert.match(h.rows()[0].textContent, /task-0/);
  h.field('search', 'r-28', 'input'); assert.equal(h.rows().length, 1);
  const row = h.rows()[0]; row.focus(); row.click();
  h.desk.update({ ...view, attempts: attempts.map(r => r.id === 'r-28' ? { ...r, state: 'backoff' } : r).reverse() });
  assert.equal(h.doc.activeElement, row); assert.equal(h.rows()[0], row); assert.equal(h.id('search').value, 'r-28');
  assert.match(row.textContent, /Backoff/); h.desk.focusSearch(); assert.equal(h.doc.activeElement, h.id('search'));
  h.desk.restoreFocus(); assert.equal(h.doc.activeElement, row);
  h.desk.update({ ...view, attempts: [] }); assert.equal(h.doc.activeElement, h.id('search'));
  h.desk.reset(); row.click(); assert.equal(h.picks.length, 1);
  assert.equal(h.id('search').value, ''); assert.doesNotMatch(h.work.textContent + h.shift.textContent, /r-28|task-28|att_digest/);
});

test('draft suggestion is isolated to an eligible fixture on Queue, including async cancellation', async () => {
  const h = setup(), v = observed('shift'); h.desk.update(v, { demo: true }); h.tab('Queue').click();
  const loaded = import('../apps/rizzstack-hive/queue-desk.js');
  h.desk.update(v, { demo: true, historical: true }); await loaded; await setImmediate();
  assert.doesNotMatch(h.work.textContent, /PARTIAL · reconciliation suggestion|AC-004/);
  h.desk.update(v, { demo: true }); await setImmediate(); assert.match(h.work.textContent, /PARTIAL · reconciliation suggestion/);
  h.tab('All').click(); assert.doesNotMatch(h.work.textContent, /AC-004/);
  h.desk.update(v); h.tab('Queue').click(); assert.doesNotMatch(h.work.textContent, /AC-004/);
  h.desk.update(observed('degraded'), { demo: true }); await setImmediate(); assert.doesNotMatch(h.work.textContent, /AC-004/);
  h.desk.reset(); assert.doesNotMatch(h.work.textContent, /AC-004/);
});

test('absent cost and time stay unknown, zero cost is retained, and display strings are inert', () => {
  const h = setup(); h.desk.update({}); h.desk.setScope('usage');
  assert.match(h.work.textContent, /subtotal: unknown.*pricing coverage unknown/i);
  const v = observed('shift'); h.desk.update({ ...v, metrics: { cost: 0 } }); assert.match(h.work.textContent, /USD 0/);
  const id = 'a<not-markup>', a = { id, state: 'running' };
  h.desk.update({ attempts: [a] }); h.desk.setScope('attempt'); assert.match(h.work.textContent, /Task unknown.*Route unknown.*Job: unknown/s);
  assert.match(h.rows()[0].getAttribute('aria-label'), /Observation time unknown/);
  assert.equal(h.shift.textContent.includes('In flight unknown'), true);
  assert.equal(h.find(n => n.tagName === 'not-markup'), undefined);
  h.rows()[0].click(); assert.deepEqual(h.picks.pop(), { kind: 'attempt', id });
});
