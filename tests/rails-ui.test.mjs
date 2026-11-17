import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(here, '..', 'apps', 'rizzstack-rails');

const readAppFile = (name) => readFileSync(join(APP_DIR, name), 'utf8');

let rails = null;
let appMod = null;
let inspMod = null;

async function load() {
  if (rails && appMod && inspMod) return { rails, appMod, inspMod };
  rails = null;
  appMod = null;
  inspMod = null;
  try {
    rails = await import(pathToFileURL(join(APP_DIR, 'rails.js')).href);
    appMod = await import(pathToFileURL(join(APP_DIR, 'app.js')).href);
    inspMod = await import(pathToFileURL(join(APP_DIR, 'inspector.js')).href);
  } catch (err) {
    rails = null;
    appMod = null;
    inspMod = null;
    throw err;
  }
  return { rails, appMod, inspMod };
}

function makeDoc() {
  const innerHTMLUses = [];
  class ClassList {
    constructor(el) {
      this.el = el;
    }
    tokens() {
      return new Set(String(this.el.attributes.class || '').split(/\s+/).filter(Boolean));
    }
    write(set_) {
      const value = [...set_].join(' ');
      if (value) this.el.attributes.class = value;
      else delete this.el.attributes.class;
    }
    add(...names) {
      const set_ = this.tokens();
      for (const name of names) set_.add(name);
      this.write(set_);
    }
    remove(...names) {
      const set_ = this.tokens();
      for (const name of names) set_.delete(name);
      this.write(set_);
    }
    toggle(name) {
      const set_ = this.tokens();
      if (set_.has(name)) set_.delete(name);
      else set_.add(name);
      this.write(set_);
      return set_.has(name);
    }
    contains(name) {
      return this.tokens().has(name);
    }
  }
  class FakeElement {
    constructor(doc, tag, ns = null) {
      this.ownerDocument = doc;
      this.tagName = String(tag).toUpperCase();
      this.namespaceURI = ns;
      this.childNodes = [];
      this.parentNode = null;
      this.attributes = {};
      this._listeners = {};
      this.classList = new ClassList(this);
      this._text = '';
      this.dataset = {};
      this.style = {};
    }
    get children() {
      return this.childNodes;
    }
    set textContent(value) {
      this._text = String(value);
      this.childNodes = [];
    }
    get textContent() {
      return this._text;
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    }
    hasAttribute(name) {
      return name in this.attributes;
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    append(...kids) {
      for (const kid of kids) this.appendChild(kid);
    }
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this._listeners[type];
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    }
    fire(type, props = {}) {
      const event = {
        type,
        target: this,
        currentTarget: this,
        key: undefined,
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {},
        ...props,
      };
      for (const fn of [...(this._listeners[type] || [])]) fn(event);
      return event;
    }
    focus() {
      this.ownerDocument.activeElement = this;
    }
    blur() {
      if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    }
    set innerHTML(value) {
      innerHTMLUses.push({ tagName: this.tagName, value: String(value) });
    }
    get innerHTML() {
      return '';
    }
  }
  const doc = {
    activeElement: null,
    createElement: (tag) => new FakeElement(doc, tag),
    createElementNS: (ns, tag) => new FakeElement(doc, tag, ns),
    createTextNode: (text) => {
      const el = new FakeElement(doc, '#text');
      el._text = String(text);
      return el;
    },
  };
  return { doc, innerHTMLUses };
}

function walk(el, fn) {
  fn(el);
  for (const child of el.childNodes) walk(child, fn);
}

function all(root, predicate) {
  const out = [];
  walk(root, (el) => {
    if (predicate(el)) out.push(el);
  });
  return out;
}

function byClass(root, cls) {
  return all(root, (el) => el.classList && el.classList.contains(cls));
}

function allText(root) {
  let out = '';
  walk(root, (el) => {
    out += (el.textContent || '') + '\n';
  });
  return out;
}

function attrsOf(root) {
  const found = [];
  walk(root, (el) => {
    for (const [name, value] of Object.entries(el.attributes || {})) found.push({ el, name, value });
  });
  return found;
}

function assertNoInnerHTML(innerHTMLUses) {
  assert.equal(innerHTMLUses.length, 0, `innerHTML was used: ${JSON.stringify(innerHTMLUses)}`);
}

function mark(over = {}) {
  return {
    event_id: 'evt-x',
    kind: 'test.run',
    occurred_at: '2026-11-17T08:57:00.000000Z',
    duration_ms: 1200,
    timing_quality: 'measured',
    outcome: 'passed',
    evidence_refs: ['run-42'],
    ghost: false,
    ...over,
  };
}

function baseView(over = {}) {
  return {
    schema: 'rizzstack.rails-view/1',
    generated_at: '2026-11-17T08:57:00.000000Z',
    lanes: [],
    completeness: 'complete',
    missing_sources: [],
    integrity: { status: 'ok', checked_through: 'seq-0042' },
    ...over,
  };
}

const FOUR_LANE_VIEW = baseView({
  completeness: 'partial',
  missing_sources: ['tokencounts'],
  lanes: [
    {
      lane_id: 'lane-root',
      parent_lane_id: null,
      status: 'open',
      source_status: 'live',
      marks: [
        mark({ event_id: 'evt-001', outcome: 'passed', timing_quality: 'measured' }),
        mark({ event_id: 'evt-002', outcome: 'red', timing_quality: 'estimated' }),
        mark({
          event_id: 'evt-003',
          outcome: 'failed',
          occurred_at: null,
          duration_ms: null,
          timing_quality: 'unknown',
          evidence_refs: [],
        }),
      ],
    },
    {
      lane_id: 'lane-child',
      parent_lane_id: 'lane-root',
      status: 'closed',
      source_status: 'stale',
      marks: [mark({ event_id: 'evt-101', outcome: 'passed' })],
    },
    {
      lane_id: 'lane-ghost',
      parent_lane_id: 'lane-root',
      status: 'ghost',
      source_status: 'live',
      marks: [mark({ event_id: 'evt-201', ghost: true, outcome: null })],
    },
    {
      lane_id: 'lane-orphan',
      parent_lane_id: 'lane-missing',
      status: 'orphan',
      source_status: 'unavailable',
      marks: [],
    },
  ],
});

const HOSTILE_VIEW = baseView({
  completeness: 'partial',
  missing_sources: ['src"><img src=x onerror=alert(4)>'],
  integrity: { status: 'ok', checked_through: 'x" onmouseover=alert(5)' },
  lanes: [
    {
      lane_id: 'lane"><img src=x onerror=alert(1)>',
      parent_lane_id: null,
      status: 'open',
      source_status: 'live',
      marks: [
        {
          event_id: 'evt-<img src=x onerror=alert(1)>',
          kind: 'test.run<b>',
          occurred_at: null,
          duration_ms: null,
          timing_quality: 'unknown',
          outcome: '"><svg onload=alert(2)>',
          evidence_refs: ['ref"><script>alert(3)</script>'],
          ghost: false,
        },
      ],
    },
  ],
});

function bigView(laneCount, marksPerLane) {
  const lanes = [];
  for (let l = 0; l < laneCount; l += 1) {
    const marks = [];
    for (let m = 0; m < marksPerLane; m += 1) {
      marks.push(mark({ event_id: `evt-${l}-${m}`, outcome: 'passed' }));
    }
    lanes.push({
      lane_id: `lane-${l}`,
      parent_lane_id: null,
      status: 'open',
      source_status: 'live',
      marks,
    });
  }
  return baseView({ lanes });
}

test('rails view module loads and validates the canonical view', async () => {
  const { rails } = await load();
  assert.equal(rails.RAILS_VIEW_SCHEMA, 'rizzstack.rails-view/1');
  const result = rails.validateView(FOUR_LANE_VIEW);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('validateView rejects a wrong schema const', async () => {
  const { rails } = await load();
  const result = rails.validateView(baseView({ schema: 'rizzstack.rails-view/2' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 1);
});

test('validateView rejects a malformed generated_at timestamp', async () => {
  const { rails } = await load();
  for (const bad of ['2026-11-17T08:57:00Z', 'nope', 123]) {
    const result = rails.validateView(baseView({ generated_at: bad }));
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('validateView rejects a lane with more than 500 marks', async () => {
  const { rails } = await load();
  const lane = { lane_id: 'lane-big', parent_lane_id: null, status: 'open', source_status: 'live', marks: [] };
  for (let i = 0; i < 501; i += 1) lane.marks.push(mark({ event_id: `evt-${i}` }));
  const result = rails.validateView(baseView({ lanes: [lane] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /500/.test(e)));
});

test('validateView rejects unknown enum values', async () => {
  const { rails } = await load();
  const badStatus = baseView({
    lanes: [{ lane_id: 'l', parent_lane_id: null, status: 'running', source_status: 'live', marks: [] }],
  });
  assert.equal(rails.validateView(badStatus).ok, false);
  const badSource = baseView({
    lanes: [{ lane_id: 'l', parent_lane_id: null, status: 'open', source_status: 'live?', marks: [] }],
  });
  assert.equal(rails.validateView(badSource).ok, false);
  const badTiming = baseView({
    lanes: [
      {
        lane_id: 'l',
        parent_lane_id: null,
        status: 'open',
        source_status: 'live',
        marks: [mark({ timing_quality: 'measured!' })],
      },
    ],
  });
  assert.equal(rails.validateView(badTiming).ok, false);
  const badCompleteness = baseView({ completeness: 'most' });
  assert.equal(rails.validateView(badCompleteness).ok, false);
  const badIntegrity = baseView({ integrity: { status: 'meh', checked_through: null } });
  assert.equal(rails.validateView(badIntegrity).ok, false);
});

test('validateView rejects hostile markup in ids (schema pattern defense)', async () => {
  const { rails } = await load();
  const result = rails.validateView(HOSTILE_VIEW);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 1);
});

test('validateView enforces field shapes, caps and additionalProperties', async () => {
  const { rails } = await load();
  const manyRefs = baseView({
    lanes: [
      {
        lane_id: 'l',
        parent_lane_id: null,
        status: 'open',
        source_status: 'live',
        marks: [mark({ evidence_refs: Array.from({ length: 21 }, (_, i) => `ref-${i}`) })],
      },
    ],
  });
  assert.equal(rails.validateView(manyRefs).ok, false);

  const manyMissing = baseView({ missing_sources: Array.from({ length: 51 }, (_, i) => `src-${i}`) });
  assert.equal(rails.validateView(manyMissing).ok, false);

  const extraProp = baseView({
    lanes: [
      {
        lane_id: 'l',
        parent_lane_id: null,
        status: 'open',
        source_status: 'live',
        marks: [{ ...mark(), foo: 'bar' }],
      },
    ],
  });
  assert.equal(rails.validateView(extraProp).ok, false);

  const badDuration = baseView({
    lanes: [
      {
        lane_id: 'l',
        parent_lane_id: null,
        status: 'open',
        source_status: 'live',
        marks: [mark({ duration_ms: '1200' })],
      },
    ],
  });
  assert.equal(rails.validateView(badDuration).ok, false);

  const badOutcome = baseView({
    lanes: [
      {
        lane_id: 'l',
        parent_lane_id: null,
        status: 'open',
        source_status: 'live',
        marks: [mark({ outcome: 'has space' })],
      },
    ],
  });
  assert.equal(rails.validateView(badOutcome).ok, false);

  const missingIntegrity = { ...baseView() };
  delete missingIntegrity.integrity;
  assert.equal(rails.validateView(missingIntegrity).ok, false);
});

test('buildLaneTree nests parent/child, flags orphans and detects cycles without hanging', async () => {
  const { rails } = await load();
  const tree = rails.buildLaneTree(FOUR_LANE_VIEW);
  assert.ok(tree.byId instanceof Map);
  assert.deepEqual([...tree.orphans].sort(), ['lane-orphan']);
  assert.equal(tree.byId.get('lane-child').lane.parent_lane_id, 'lane-root');

  const cycleView = baseView({
    lanes: [
      { lane_id: 'a', parent_lane_id: 'b', status: 'open', source_status: 'live', marks: [] },
      { lane_id: 'b', parent_lane_id: 'a', status: 'open', source_status: 'live', marks: [] },
      { lane_id: 'c', parent_lane_id: null, status: 'open', source_status: 'live', marks: [] },
    ],
  });
  const cycleTree = rails.buildLaneTree(cycleView);
  assert.ok(cycleTree.cycles.length >= 1);
  const flat = cycleTree.cycles.flat();
  assert.ok(flat.includes('a') && flat.includes('b'));
  const rootIds = cycleTree.roots.map((node) => node.lane.lane_id).sort();
  assert.deepEqual(rootIds, ['a', 'b', 'c']);
});

test('boundMarksForView caps per-lane marks, total visible marks and lane count', async () => {
  const { rails } = await load();
  const single = rails.boundMarksForView({ lanes: [{ lane_id: 'l', marks: Array.from({ length: 700 }, () => ({})) }] });
  assert.equal(single.lanes[0].visible, 500);
  assert.equal(single.lanes[0].omitted, 200);
  assert.equal(single.totalVisible, 500);
  assert.equal(single.totalHidden, 200);

  const fiveHeavy = rails.boundMarksForView({
    lanes: Array.from({ length: 5 }, (_, i) => ({ lane_id: `lane-${i}`, marks: Array.from({ length: 800 }, () => ({})) })),
  });
  assert.equal(fiveHeavy.totalVisible, 2000);
  assert.equal(fiveHeavy.totalHidden, 2000);
  assert.equal(fiveHeavy.lanes[0].visible, 500);
  assert.equal(fiveHeavy.lanes[4].visible, 0);

  const manyLanes = rails.boundMarksForView({
    lanes: Array.from({ length: 600 }, (_, i) => ({ lane_id: `lane-${i}`, marks: [{}] })),
  });
  assert.equal(manyLanes.lanesVisible, 500);
  assert.equal(manyLanes.lanesHidden, 100);
  assert.equal(manyLanes.totalVisible, 500);
  assert.equal(manyLanes.totalHidden, 100);
});

test('breadcrumbPath walks ancestors and marks missing ones as orphan placeholders', async () => {
  const { rails } = await load();
  const chainView = baseView({
    lanes: [
      { lane_id: 'lane-root', parent_lane_id: null, status: 'open', source_status: 'live', marks: [] },
      { lane_id: 'lane-mid', parent_lane_id: 'lane-root', status: 'open', source_status: 'live', marks: [] },
      { lane_id: 'lane-leaf', parent_lane_id: 'lane-mid', status: 'open', source_status: 'live', marks: [] },
    ],
  });
  const path = rails.breadcrumbPath('lane-leaf', rails.buildLaneIndex(chainView));
  assert.deepEqual(
    path.map((c) => c.lane_id),
    ['lane-root', 'lane-mid', 'lane-leaf'],
  );
  assert.ok(path.every((c) => c.missing === false));

  const orphanPath = rails.breadcrumbPath('lane-orphan', rails.buildLaneIndex(FOUR_LANE_VIEW));
  assert.deepEqual(orphanPath, [
    { lane_id: 'lane-missing', missing: true },
    { lane_id: 'lane-orphan', missing: false },
  ]);

  assert.deepEqual(rails.breadcrumbPath('nope', rails.buildLaneIndex(chainView)), [{ lane_id: 'nope', missing: true }]);
});

test('outcomeClass separates red, failure, ok, ghost-unknown and other outcomes', async () => {
  const { rails } = await load();
  assert.equal(rails.outcomeClass('red'), 'red');
  assert.equal(rails.outcomeClass('failed'), 'failure');
  assert.equal(rails.outcomeClass('passed'), 'ok');
  assert.equal(rails.outcomeClass(null), 'unknown');
  assert.equal(rails.outcomeClass('weird-outcome'), 'other');
  assert.notEqual(rails.outcomeClass('red'), rails.outcomeClass('failed'));
  assert.notEqual(rails.outcomeClass('failed'), rails.outcomeClass('passed'));
});

test('formatTimestamp and formatDuration never invent values', async () => {
  const { rails } = await load();
  assert.equal(rails.formatTimestamp('2026-11-17T08:57:00.000000Z'), '2026-11-17T08:57:00.000000Z');
  assert.equal(rails.formatTimestamp(null), 'unknown');
  assert.equal(rails.formatTimestamp(undefined), 'unknown');
  assert.equal(rails.formatDuration(1200), '1200 ms');
  assert.equal(rails.formatDuration(null), 'unknown');
  assert.equal(rails.formatDuration(undefined), 'unknown');
});

test('rendering shows lanes with distinct status and source classes and distinct mark outcome classes', async () => {
  const { appMod } = await load();
  const { doc, innerHTMLUses } = makeDoc();
  const container = doc.createElement('div');
  const app = appMod.createObservatory({ container, view: FOUR_LANE_VIEW, document: doc });
  assertNoInnerHTML(innerHTMLUses);

  const laneGroups = byClass(container, 'rail-lane');
  assert.equal(laneGroups.length, 4);
  const laneById = new Map(laneGroups.map((el) => [el.getAttribute('data-lane-id'), el]));
  assert.ok(laneById.get('lane-root').classList.contains('rail-lane--open'));
  assert.ok(laneById.get('lane-child').classList.contains('rail-lane--closed'));
  assert.ok(laneById.get('lane-ghost').classList.contains('rail-lane--ghost'));
  assert.ok(laneById.get('lane-orphan').classList.contains('rail-lane--orphan'));

  assert.ok(byClass(container, 'rail-source--live').length >= 1);
  assert.ok(byClass(container, 'rail-source--stale').length >= 1);
  assert.ok(byClass(container, 'rail-source--unavailable').length >= 1);

  const markById = new Map(byClass(container, 'rail-mark').map((el) => [el.getAttribute('data-event-id'), el]));
  assert.ok(markById.get('evt-001').classList.contains('rail-mark--ok'));
  assert.ok(markById.get('evt-002').classList.contains('rail-mark--red'));
  assert.ok(markById.get('evt-003').classList.contains('rail-mark--failure'));
  assert.ok(markById.get('evt-201').classList.contains('rail-mark--ghost'));
  assert.ok(markById.get('evt-201').classList.contains('rail-mark--unknown'));
  assert.ok(markById.get('evt-001').getAttribute('tabindex') === '0');
  assert.ok(markById.get('evt-001').getAttribute('role') === 'button');
  assert.ok(String(markById.get('evt-001').getAttribute('aria-label')).includes('lane-root'));
  assert.equal(app.error, null);
});

test('unknown values render honestly without fabricated timestamps or durations', async () => {
  const { appMod } = await load();
  const { doc } = makeDoc();
  const container = doc.createElement('div');
  appMod.createObservatory({ container, view: FOUR_LANE_VIEW, document: doc });
  const evt3 = byClass(container, 'rail-mark').find((el) => el.getAttribute('data-event-id') === 'evt-003');
  assert.ok(evt3, 'evt-003 mark not rendered');
  const label = evt3.getAttribute('aria-label') || '';
  assert.ok(label.includes('unknown time'), `label missing unknown time: ${label}`);
  assert.ok(label.includes('unknown duration'), `label missing unknown duration: ${label}`);
  assert.ok(!/[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(label), `fabricated timestamp in label: ${label}`);
  assert.ok(allText(container).includes('unknown time'));
});

test('rendering bounds visible marks to the schema cap with an honest truncation indicator', async () => {
  const { appMod } = await load();
  const { doc } = makeDoc();
  const container = doc.createElement('div');
  appMod.createObservatory({ container, view: bigView(5, 500), document: doc });
  assert.equal(byClass(container, 'rail-mark').length, 2000);
  const badges = byClass(container, 'rails-truncated');
  assert.ok(badges.length >= 1, 'no truncation indicator rendered');
  const badgeText = badges.map((el) => el.textContent).join(' ');
  assert.ok(badgeText.includes('500') && badgeText.includes('hidden'), `badge text: ${badgeText}`);
  assert.ok(allText(container).includes('500 hidden'));
});

test('hostile markup-bearing data renders as inert text, never as markup (XSS escape proof)', async () => {
  const { appMod } = await load();
  const { doc, innerHTMLUses } = makeDoc();
  const container = doc.createElement('div');
  appMod.createObservatory({ container, view: HOSTILE_VIEW, document: doc, validate: false });
  assertNoInnerHTML(innerHTMLUses);
  const tagNames = new Set(all(container, () => true).map((el) => el.tagName));
  assert.ok(!tagNames.has('IMG'), 'an IMG element was created from data');
  assert.ok(!tagNames.has('SCRIPT'), 'a SCRIPT element was created from data');
  for (const attr of attrsOf(container)) {
    assert.notEqual(attr.name.toLowerCase(), 'onerror', 'an onerror attribute was injected');
  }
  const text = allText(container);
  assert.ok(text.includes('lane"><img src=x onerror=alert(1)>'), 'hostile lane id not rendered verbatim as text');
  assert.ok(
    text.includes('src"><img src=x onerror=alert(4)>'),
    'hostile missing source not rendered verbatim as text',
  );
  const hostileMark = byClass(container, 'rail-mark')[0];
  assert.ok(hostileMark, 'hostile mark not rendered');
  assert.equal(hostileMark.getAttribute('data-event-id'), 'evt-<img src=x onerror=alert(1)>');
  assert.ok(
    String(hostileMark.getAttribute('aria-label')).includes('evt-<img src=x onerror=alert(1)>'),
    'hostile event id not carried verbatim in aria-label',
  );
});

test('clean rendering never touches innerHTML (defense in depth)', async () => {
  const { appMod } = await load();
  const { doc, innerHTMLUses } = makeDoc();
  const container = doc.createElement('div');
  appMod.createObservatory({ container, view: FOUR_LANE_VIEW, document: doc });
  appMod.createObservatory({ container, view: bigView(3, 10), document: doc });
  assertNoInnerHTML(innerHTMLUses);
});

test('marks are keyboard reachable: initial selection, arrow navigation and Enter selection event', async () => {
  const { appMod } = await load();
  const { doc } = makeDoc();
  const container = doc.createElement('div');
  const onSelectCalls = [];
  appMod.createObservatory({
    container,
    view: FOUR_LANE_VIEW,
    document: doc,
    onSelect: (ctx) => onSelectCalls.push(ctx),
  });
  const marks = byClass(container, 'rail-mark');
  assert.equal(marks.length, 5);
  assert.ok(marks[0].classList.contains('rail-mark--selected'), 'no initial selection');
  container.fire('keydown', { key: 'ArrowRight' });
  assert.ok(marks[1].classList.contains('rail-mark--selected'), 'ArrowRight did not advance selection');
  assert.ok(!marks[0].classList.contains('rail-mark--selected'), 'previous selection not cleared');
  container.fire('keydown', { key: 'Enter' });
  assert.equal(onSelectCalls.length, 1);
  assert.equal(onSelectCalls[0].mark.event_id, 'evt-002');
  assert.equal(onSelectCalls[0].lane.lane_id, 'lane-root');
  assert.ok(Array.isArray(onSelectCalls[0].breadcrumbs));
  container.fire('keydown', { key: 'ArrowLeft' });
  assert.ok(marks[0].classList.contains('rail-mark--selected'), 'ArrowLeft did not move selection back');
});

test('zoom and pan transform the viewport with clamped bounds and a reset', async () => {
  const { appMod } = await load();
  const { doc } = makeDoc();
  const container = doc.createElement('div');
  const app = appMod.createObservatory({ container, view: FOUR_LANE_VIEW, document: doc });
  assert.deepEqual(app.getTransform(), { scale: 1, tx: 0, ty: 0 });
  app.zoomBy(2);
  assert.equal(app.getTransform().scale, 2);
  const viewport = byClass(container, 'rails-viewport')[0];
  assert.match(viewport.getAttribute('transform'), /scale\(2\)/);
  app.zoomBy(1e9);
  assert.equal(app.getTransform().scale, 8);
  app.zoomBy(1e-9);
  assert.equal(app.getTransform().scale, 0.25);
  app.panBy(1e7, 0);
  assert.equal(app.getTransform().tx, 20000);
  app.resetView();
  assert.deepEqual(app.getTransform(), { scale: 1, tx: 0, ty: 0 });
  const svg = byClass(container, 'rails-svg')[0];
  svg.fire('wheel', { deltaY: -240 });
  assert.ok(app.getTransform().scale > 1, 'wheel with negative deltaY should zoom in');
  svg.fire('wheel', { deltaY: 1e6 });
  assert.equal(app.getTransform().scale, 0.25, 'wheel zoom must clamp at the minimum scale');
});

test('focus mode narrows to a subtree with breadcrumb navigation and restores on clear', async () => {
  const { appMod } = await load();
  const { doc } = makeDoc();
  const container = doc.createElement('div');
  const app = appMod.createObservatory({ container, view: FOUR_LANE_VIEW, document: doc });
  app.focusLane('lane-child');
  assert.equal(app.getFocusedLaneId(), 'lane-child');
  const focusedIds = byClass(container, 'rail-lane').map((el) => el.getAttribute('data-lane-id'));
  assert.deepEqual(focusedIds, ['lane-child']);
  const crumbs = byClass(container, 'rails-crumb').map((el) => el.textContent);
  assert.deepEqual(crumbs, ['lane-root', 'lane-child']);
  app.focusLane(null);
  assert.equal(app.getFocusedLaneId(), null);
  const restored = byClass(container, 'rail-lane').map((el) => el.getAttribute('data-lane-id')).sort();
  assert.deepEqual(restored, ['lane-child', 'lane-ghost', 'lane-orphan', 'lane-root']);
});

test('reduced motion preference is reflected on the container', async () => {
  const { appMod } = await load();
  const { doc } = makeDoc();
  const container = doc.createElement('div');
  appMod.createObservatory({ container, view: FOUR_LANE_VIEW, document: doc, reducedMotion: true });
  assert.equal(container.getAttribute('data-reduced-motion'), 'true');
});

test('an invalid view renders an error state and no marks', async () => {
  const { appMod } = await load();
  const { doc } = makeDoc();
  const container = doc.createElement('div');
  const app = appMod.createObservatory({ container, view: baseView({ generated_at: 'nope' }), document: doc });
  assert.ok(byClass(container, 'rails-error').length >= 1);
  assert.equal(byClass(container, 'rail-mark').length, 0);
  assert.ok(app.error && app.error.length >= 1);
});

test('toolbar exposes accessible zoom, reset and focus controls that work', async () => {
  const { appMod } = await load();
  const { doc } = makeDoc();
  const container = doc.createElement('div');
  const app = appMod.createObservatory({ container, view: FOUR_LANE_VIEW, document: doc });
  const tools = byClass(container, 'rails-tool');
  assert.equal(tools.length, 4);
  const labels = tools.map((el) => el.getAttribute('aria-label'));
  for (const expected of ['Zoom in', 'Zoom out', 'Reset view', 'Toggle focus mode']) {
    assert.ok(labels.includes(expected), `missing tool: ${expected}`);
  }
  assert.ok(tools.every((el) => el.tagName === 'BUTTON'));
  const zoomIn = tools.find((el) => el.getAttribute('aria-label') === 'Zoom in');
  zoomIn.fire('click');
  assert.equal(app.getTransform().scale, 1.25);
});

test('inspector renders honest mark detail with breadcrumbs and escapes hostile strings', async () => {
  const { rails, inspMod } = await load();
  const { doc, innerHTMLUses } = makeDoc();
  const container = doc.createElement('div');
  const inspector = inspMod.createInspector({ container, document: doc });
  assert.equal(inspector.isOpen(), false);
  inspector.show({
    lane: FOUR_LANE_VIEW.lanes[2],
    mark: FOUR_LANE_VIEW.lanes[2].marks[0],
    breadcrumbs: rails.breadcrumbPath('lane-ghost', rails.buildLaneIndex(FOUR_LANE_VIEW)),
  });
  assert.equal(inspector.isOpen(), true);
  assert.equal(container.getAttribute('hidden'), null);
  const text = allText(container);
  assert.ok(text.includes('evt-201'));
  assert.ok(text.includes('test.run'));
  const valueFor = (label) => {
    const rows = byClass(container, 'rails-inspector__row');
    const rowEl = rows.find((el) => el.childNodes[0] && el.childNodes[0].textContent === label);
    return rowEl ? rowEl.childNodes[1].textContent : null;
  };
  assert.equal(valueFor('Occurred at'), '2026-11-17T08:57:00.000000Z');
  assert.equal(valueFor('Duration'), '1200 ms');
  assert.equal(valueFor('Outcome'), 'unknown');
  assert.equal(valueFor('Ghost'), 'yes');
  assert.equal(valueFor('Timing'), 'measured');
  const crumbs = byClass(container, 'rails-crumb').map((el) => el.textContent);
  assert.deepEqual(crumbs, ['lane-root', 'lane-ghost']);
  assert.equal(byClass(container, 'rails-inspector__evidence')[0].childNodes.length, 1);
  assertNoInnerHTML(innerHTMLUses);

  inspector.show({
    lane: FOUR_LANE_VIEW.lanes[0],
    mark: FOUR_LANE_VIEW.lanes[0].marks[2],
    breadcrumbs: [],
  });
  assert.equal(valueFor('Occurred at'), 'unknown');
  assert.equal(valueFor('Duration'), 'unknown');
  assert.equal(valueFor('Timing'), 'unknown');
  assert.equal(valueFor('Ghost'), 'no');
  assertNoInnerHTML(innerHTMLUses);

  const hostileContainer = doc.createElement('div');
  const hostileInspector = inspMod.createInspector({ container: hostileContainer, document: doc });
  hostileInspector.show({
    lane: HOSTILE_VIEW.lanes[0],
    mark: HOSTILE_VIEW.lanes[0].marks[0],
    breadcrumbs: [{ lane_id: 'lane"><img src=x onerror=alert(1)>', missing: false }],
  });
  assert.equal(innerHTMLUses.length, 0, 'inspector used innerHTML with hostile data');
  const hostileText = allText(hostileContainer);
  assert.ok(hostileText.includes('evt-<img src=x onerror=alert(1)>'), 'hostile event id not verbatim');
  assert.ok(hostileText.includes('ref"><script>alert(3)</script>'), 'hostile evidence not verbatim');
  for (const attr of attrsOf(hostileContainer)) {
    assert.notEqual(attr.name.toLowerCase(), 'onerror', 'onerror attribute injected by inspector');
  }
  const tagNames = new Set(all(hostileContainer, () => true).map((el) => el.tagName));
  assert.ok(!tagNames.has('IMG') && !tagNames.has('SCRIPT'));
});

test('inspector closes via close(), the close button and the Escape key', async () => {
  const { inspMod } = await load();
  const { doc } = makeDoc();
  const container = doc.createElement('div');
  const closes = [];
  const inspector = inspMod.createInspector({ container, document: doc, onClose: () => closes.push(1) });
  inspector.show({
    lane: FOUR_LANE_VIEW.lanes[0],
    mark: FOUR_LANE_VIEW.lanes[0].marks[0],
    breadcrumbs: [],
  });
  assert.equal(inspector.isOpen(), true);
  const closeButton = byClass(container, 'rails-inspector__close')[0];
  assert.ok(closeButton, 'close button missing');
  assert.equal(closeButton.getAttribute('aria-label'), 'Close inspector');
  closeButton.fire('click');
  assert.equal(inspector.isOpen(), false);
  assert.ok(container.getAttribute('hidden') !== null);
  assert.equal(closes.length, 1);
  inspector.show({
    lane: FOUR_LANE_VIEW.lanes[0],
    mark: FOUR_LANE_VIEW.lanes[0].marks[1],
    breadcrumbs: [],
  });
  container.fire('keydown', { key: 'Escape' });
  assert.equal(inspector.isOpen(), false);
  assert.equal(closes.length, 2);
});

test('index.html wires the app with a mount point and no inline script', async () => {
  const html = readAppFile('index.html');
  assert.match(html, /<script[^>]*type=["']module["'][^>]*src=["']\.\/app\.js["']/);
  assert.match(html, /href=["']\.\/styles\.css["']/);
  assert.match(html, /id=["']rails-root["']/);
  assert.match(html, /id=["']rails-inspector["']/);
  assert.match(html, /charset/i);
  assert.match(html, /viewport/i);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i);
});

test('styles.css styles the distinct lane and mark states with focus and reduced-motion support', async () => {
  const css = readAppFile('styles.css');
  assert.ok(css.includes('.rail-lane--ghost'), 'missing ghost lane style');
  assert.ok(css.includes('.rail-mark--red'), 'missing red mark style');
  assert.ok(css.includes('.rail-mark--failure'), 'missing failure mark style');
  assert.ok(css.includes(':focus-visible'), 'missing visible focus style');
  assert.ok(css.includes('prefers-reduced-motion'), 'missing reduced motion support');
  assert.ok(css.includes('.rails-inspector'), 'missing inspector style');
  assert.ok(css.includes('.rails-crumb'), 'missing breadcrumb style');
});

test('bootObservatory is a no-op without a document', async () => {
  const { appMod } = await load();
  assert.equal(appMod.bootObservatory(), null);
});
