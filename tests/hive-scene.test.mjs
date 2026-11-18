import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../apps/rizzstack-hive/scene.js';

// Small SVG host for deterministic identity/focus tests without a layout engine.
class Element extends EventTarget {
  constructor(tag, doc) { super(); this.tagName = tag; this.ownerDocument = doc; }
  attributes = new Map(); children = []; textContent = ''; flashes = 0;
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
  remove() { this.parentNode.children = this.parentNode.children.filter(el => el !== this); }
  focus() { this.ownerDocument.activeElement = this; }
  animate() { this.flashes++; return { cancel() {} }; }
}
function host(reduce = false) {
  const doc = { createElementNS: (_, tag) => new Element(tag, doc),
    defaultView: { matchMedia: () => ({ matches: reduce }) } };
  const container = new Element('div', doc), picks = [];
  const scene = createScene(container, { onSelect: s => picks.push(s) });
  const all = (root = container) => root.children.flatMap(el => [el, ...all(el)]);
  const objects = kind => all().filter(el => el.getAttribute('data-kind') === kind);
  const get = (kind, id) => objects(kind).find(el => el.getAttribute('data-id') === id);
  return { container, doc, scene, picks, all, objects, get };
}
const ids = ['auth','dispatch','build','verify','review','integrate','deploy','receiver'];
const attempts = n => Array.from({length:n}, (_, i) => ({id:`worker-${String(i).padStart(2,'0')}`,stage:'build',state:'running',quality:'known',route:'local'}));
const key = (el,value) => { const event = new Event('keydown',{cancelable:true}); Object.defineProperty(event,'key',{value}); el.dispatchEvent(event); };

test('an absent projection still has eight fixed stations, with no manufactured queue or worker', () => {
  const h = host(); h.scene.update({}, null);
  assert.deepEqual(h.objects('station').map(el=>el.getAttribute('data-id')),ids);
  assert.equal(h.objects('attempt').length,0);
  for (const station of h.objects('station')) {
    assert.match(station.getAttribute('aria-label'),/queue (depth )?unknown/i);
    assert.equal(station.getAttribute('data-gap'),'true');
  }
});

test('fourteen exact identities; refresh, reorder and removal preserve nodes, focused object and slots', () => {
  const h = host(), rows = attempts(14);
  h.scene.update({attempts:rows});
  const originals = h.objects('attempt').map(el=>[el,el.getAttribute('data-id'),el.getAttribute('transform')]);
  assert.equal(originals.length,14);
  assert.equal(new Set(originals.map(r=>r[2])).size,14);
  originals[5][0].focus();
  h.scene.update({attempts:[...rows.slice(1).reverse(), ...attempts(16).slice(14)]}, {kind:'attempt',id:originals[5][1]});
  for (const [el,id,position] of originals.slice(1)) {
    assert.equal(h.get('attempt',id),el); assert.equal(el.getAttribute('transform'),position);
  }
  assert.equal(h.doc.activeElement,originals[5][0]);
  assert.equal(originals[5][0].getAttribute('aria-pressed'),'true');
});

test('overflow counts unique IDs and opens the externally selected identity even past the cap', () => {
  const h = host(), rows = attempts(34);
  h.scene.update({attempts:[...rows,null,{},rows[0]]},{kind:'attempt',id:'worker-33'});
  assert.equal(h.objects('attempt').length,30);
  assert.equal(h.get('attempt','worker-33').getAttribute('aria-pressed'),'true');
  assert(h.all().some(el=>/30\s*\/\s*34/.test(el.textContent)));
  assert(!h.get('attempt','undefined'));
  assert(h.all().length<=500,`30 identities used ${h.all().length} SVG nodes`);
});

test('cold-start geography is independent of source order, and DOM IDs are local to each plate', () => {
  const a=host(), b=host(), rows=attempts(30);
  a.scene.update({attempts:rows});b.scene.update({attempts:[...rows].reverse()});
  for(const {id} of rows) assert.equal(a.get('attempt',id).getAttribute('transform'),b.get('attempt',id).getAttribute('transform'));
  const ids=all=>all.map(el=>el.getAttribute('id')).filter(Boolean);
  const unique=new Set([...ids(a.all()),...ids(b.all())]);
  assert.equal(unique.size,ids(a.all()).length+ids(b.all()).length);
});

test('zero survives a known observation; a later missing station loses its count without remounting', () => {
  const h=host();h.scene.update({stations:[{id:'verify',level:'quiet',quality:'known',depth:0,signal:'Dwell within target'}]});
  const old=h.get('station','verify');assert.match(old.getAttribute('aria-label'),/Queue depth 0/);assert.equal(old.getAttribute('data-gap'),'false');
  h.scene.update({stations:[]},{kind:'station',id:'verify'});assert.equal(h.get('station','verify'),old);
  assert.equal(old.getAttribute('data-gap'),'true');assert.match(old.getAttribute('aria-label'),/Queue depth unknown/);
  assert(!h.all(old).some(el=>el.textContent.includes('Dwell within target')||el.textContent==='Q 0'));
});

test('station selection, spatial arrows and text controls report exact IDs without inferring a stage', () => {
  const h = host(), id = `a\"/><test>`, rows = [{id,stage:null,route:'local',quality:'partial'}];
  h.scene.update({attempts:rows});
  key(h.get('station','build'),'ArrowDown');
  assert.equal(h.doc.activeElement,h.get('station','integrate'));
  key(h.doc.activeElement,'Enter');
  assert.deepEqual(h.picks.pop(),{kind:'station',id:'integrate'});
  const mark=h.get('attempt',id); assert.match(mark.getAttribute('aria-label'),/stage unknown/i);
  mark.dispatchEvent(new Event('click')); assert.deepEqual(h.picks.pop(),{kind:'attempt',id});
  assert(!h.all().some(el=>el.tagName==='test'));
});

test('motion only highlights exact accepted objects on subsequent refresh, respecting reduced motion', () => {
  for (const reduce of [true,false]) {
    const h = host(reduce), rows = attempts(3), opts = {motion:true,changedIds:new Set([rows[0].id])};
    h.scene.update({attempts:rows},null,opts);
    assert.equal(h.all().reduce((a,b)=>a+b.flashes,0),0);
    h.scene.update({attempts:rows});
    h.scene.update({attempts:rows},null,opts);
    assert.equal(h.all().reduce((a,b)=>a+b.flashes,0),reduce ? 0 : 1);
    h.scene.destroy(); assert.equal(h.container.children.length,0);
    h.scene.update({attempts:rows}); assert.equal(h.container.children.length,0);
  }
});
