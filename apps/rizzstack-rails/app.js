import {
  RAILS_VIEW_SCHEMA,
  CAPS,
  validateView,
  buildLaneTree,
  boundMarksForView,
  breadcrumbPath,
  outcomeClass,
  laneClass,
  sourceClass,
} from './rails.js';
import { createInspector } from './inspector.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const PAN_LIMIT = 20000;
const LANE_H = 56;
const LABEL_W = 170;
const TIMELINE_W = 1000;
const UNKNOWN_W = 160;
const PAD = 16;
const PANE_W = LABEL_W + TIMELINE_W + UNKNOWN_W + PAD * 2;
const MARK_W = 16;
const MARK_H = 24;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function setChildren(el, kids) {
  el.textContent = '';
  for (const kid of kids) el.appendChild(kid);
  return el;
}

function htmlEl(doc, tag, className, text) {
  const el = doc.createElement(tag);
  if (className) el.classList.add(className);
  if (text !== undefined) el.textContent = String(text);
  return el;
}

function svgEl(doc, tag, className, text) {
  const el = doc.createElementNS(SVG_NS, tag);
  if (className) el.classList.add(className);
  if (text !== undefined) el.textContent = String(text);
  return el;
}

function laneStatusLabel(status) {
  return ['open', 'closed', 'orphan', 'ghost', 'unknown'].includes(status) ? status : 'unknown';
}

function sourceStatusLabel(status) {
  return ['live', 'stale', 'unavailable', 'unknown'].includes(status) ? status : 'unknown';
}

function markLabel(lane, mark) {
  const parts = [
    String(mark.event_id ?? ''),
    String(mark.kind ?? ''),
    `outcome ${mark.outcome ?? 'unknown'}`,
    mark.occurred_at == null ? 'unknown time' : String(mark.occurred_at),
    mark.duration_ms == null ? 'unknown duration' : `${mark.duration_ms} ms`,
    `timing ${mark.timing_quality ?? 'unknown'}`,
  ];
  if (mark.ghost) parts.push('ghost');
  parts.push(`lane ${lane.lane_id}`);
  return parts.join(' — ');
}

function collectSubtree(node, out) {
  if (!node) return out;
  out.push(node);
  for (const child of node.children) collectSubtree(child, out);
  return out;
}

const SAMPLE_VIEW = {
  schema: RAILS_VIEW_SCHEMA,
  generated_at: '2026-11-17T08:57:00.000000Z',
  lanes: [
    {
      lane_id: 'sample-root',
      parent_lane_id: null,
      status: 'open',
      source_status: 'live',
      marks: [
        {
          event_id: 'sample-evt-001',
          kind: 'test.run',
          occurred_at: '2026-11-17T08:50:00.000000Z',
          duration_ms: 1200,
          timing_quality: 'measured',
          outcome: 'passed',
          evidence_refs: ['sample-run-1'],
          ghost: false,
        },
        {
          event_id: 'sample-evt-002',
          kind: 'test.run',
          occurred_at: '2026-11-17T08:52:00.000000Z',
          duration_ms: 900,
          timing_quality: 'estimated',
          outcome: 'red',
          evidence_refs: ['sample-run-2'],
          ghost: false,
        },
        {
          event_id: 'sample-evt-003',
          kind: 'build.compile',
          occurred_at: null,
          duration_ms: null,
          timing_quality: 'unknown',
          outcome: null,
          evidence_refs: [],
          ghost: false,
        },
      ],
    },
    {
      lane_id: 'sample-child',
      parent_lane_id: 'sample-root',
      status: 'closed',
      source_status: 'stale',
      marks: [
        {
          event_id: 'sample-evt-101',
          kind: 'deploy.rollout',
          occurred_at: '2026-11-17T08:54:00.000000Z',
          duration_ms: 45000,
          timing_quality: 'measured',
          outcome: 'failed',
          evidence_refs: ['sample-run-3'],
          ghost: false,
        },
      ],
    },
    {
      lane_id: 'sample-ghost',
      parent_lane_id: 'sample-root',
      status: 'ghost',
      source_status: 'live',
      marks: [
        {
          event_id: 'sample-evt-201',
          kind: 'test.run',
          occurred_at: '2026-11-16T21:00:00.000000Z',
          duration_ms: null,
          timing_quality: 'unknown',
          outcome: null,
          evidence_refs: [],
          ghost: true,
        },
      ],
    },
    {
      lane_id: 'sample-orphan',
      parent_lane_id: 'sample-missing',
      status: 'orphan',
      source_status: 'unavailable',
      marks: [],
    },
  ],
  completeness: 'partial',
  missing_sources: ['sample-missing-source'],
  integrity: { status: 'ok', checked_through: 'sample-seq-0042' },
};

export function createObservatory({
  container,
  view,
  document = globalThis.document,
  reducedMotion = false,
  onSelect = () => {},
  note = null,
  caps = CAPS,
  validate = true,
} = {}) {
  if (!container) throw new Error('createObservatory: container is required');
  if (!document) throw new Error('createObservatory: document is required');

  const state = {
    scale: 1,
    tx: 0,
    ty: 0,
    focusedLaneId: null,
    selectionIndex: -1,
    ordered: [],
    destroyed: false,
  };

  let validation = { ok: true, errors: [] };
  if (validate) validation = validateView(view);

  const app = {
    error: validation.ok ? null : validation.errors,
  };

  let tree = null;
  let viewport = null;
  let svg = null;
  let breadcrumbBar = null;

  if (!validation.ok) {
    renderErrorState();
  } else {
    tree = buildLaneTree(view);
    render();
  }

  function renderErrorState() {
    container.classList.add('rails-app');
    container.setAttribute('data-reduced-motion', reducedMotion ? 'true' : 'false');
    setChildren(container, []);
    const box = htmlEl(document, 'div', 'rails-error');
    const title = htmlEl(document, 'div', 'rails-error__title', 'Invalid rails view');
    const list = htmlEl(document, 'ul', 'rails-error__list');
    for (const message of (validation.errors || []).slice(0, 50)) {
      const item = htmlEl(document, 'li', 'rails-error__item', message);
      list.appendChild(item);
    }
    box.appendChild(title);
    box.appendChild(list);
    container.appendChild(box);
  }

  function visibleLanes() {
    const allLanes = view.lanes;
    if (!state.focusedLaneId) return allLanes;
    const node = tree.byId.get(state.focusedLaneId);
    if (!node) return allLanes;
    const nodes = collectSubtree(node, []);
    const wanted = new Set(nodes.map((n) => n.lane.lane_id));
    return allLanes.filter((lane) => wanted.has(lane.lane_id));
  }

  function render() {
    if (state.destroyed) return;
    container.classList.add('rails-app');
    container.setAttribute('data-reduced-motion', reducedMotion ? 'true' : 'false');
    setChildren(container, []);

    const bounded = boundMarksForView({ lanes: visibleLanes() }, caps);
    const header = buildHeader(bounded);
    const toolbar = buildToolbar(bounded);
    breadcrumbBar = htmlEl(document, 'div', 'rails-breadcrumbs');
    renderBreadcrumbs();
    svg = buildPane(bounded);
    setChildren(container, [header, toolbar, breadcrumbBar, svg]);

    state.ordered = [];
    for (const markEl of byClassWithin(container, 'rail-mark')) {
      const laneId = markEl.getAttribute('data-lane-id');
      const eventId = markEl.getAttribute('data-event-id');
      const lane = view.lanes.find((l) => l.lane_id === laneId);
      const markObj = lane ? lane.marks.find((m) => m.event_id === eventId) : null;
      if (lane && markObj) state.ordered.push({ el: markEl, lane, mark: markObj });
    }
    state.selectionIndex = state.ordered.length > 0 ? 0 : -1;
    applySelection();
  }

  function byClassWithin(root, cls) {
    const out = [];
    const visit = (el) => {
      if (el.classList && el.classList.contains(cls)) out.push(el);
      for (const child of el.childNodes || []) visit(child);
    };
    visit(root);
    return out;
  }

  function buildHeader(bounded) {
    const header = htmlEl(document, 'div', 'rails-header');
    header.appendChild(htmlEl(document, 'div', 'rails-title', 'Rails Observatory'));
    const subtitle = htmlEl(
      document,
      'div',
      'rails-subtitle',
      `${RAILS_VIEW_SCHEMA} — generated ${view.generated_at}`,
    );
    header.appendChild(subtitle);
    if (note) header.appendChild(htmlEl(document, 'div', 'rails-note', note));

    const chips = htmlEl(document, 'div', 'rails-chips');
    chips.appendChild(htmlEl(document, 'span', `rails-chip rails-chip--${view.completeness}`, view.completeness));
    const integrity = view.integrity || { status: 'unchecked', checked_through: null };
    chips.appendChild(
      htmlEl(
        document,
        'span',
        `rails-chip rails-chip--integrity-${integrity.status}`,
        integrity.checked_through
          ? `integrity ${integrity.status} through ${integrity.checked_through}`
          : `integrity ${integrity.status}`,
      ),
    );
    const missing = Array.isArray(view.missing_sources) ? view.missing_sources.slice(0, 50) : [];
    if (missing.length > 0) {
      chips.appendChild(htmlEl(document, 'span', 'rails-chip rails-chip--missing', `missing sources: ${missing.length}`));
    }
    if (tree && tree.cycles.length > 0) {
      chips.appendChild(htmlEl(document, 'span', 'rails-chip rails-chip--warn', 'parent cycle detected'));
    }
    header.appendChild(chips);

    const summary = htmlEl(
      document,
      'div',
      'rails-summary',
      `lanes ${bounded.lanesVisible}/${view.lanes.length}` +
        (bounded.lanesHidden > 0 ? `, lanes hidden ${bounded.lanesHidden}` : '') +
        ` — marks ${bounded.totalVisible} visible, ${bounded.totalHidden} hidden`,
    );
    header.appendChild(summary);

    if (missing.length > 0) {
      const missingList = htmlEl(document, 'div', 'rails-missing');
      for (const source of missing) missingList.appendChild(htmlEl(document, 'div', 'rails-missing__item', source));
      header.appendChild(missingList);
    }
    return header;
  }

  function buildToolbar(bounded) {
    const toolbar = htmlEl(document, 'div', 'rails-toolbar');
    const tools = [
      { label: 'Zoom in', text: '+', action: () => zoomBy(1.25) },
      { label: 'Zoom out', text: '−', action: () => zoomBy(0.8) },
      { label: 'Reset view', text: 'Reset', action: () => resetView() },
      {
        label: 'Toggle focus mode',
        text: 'Focus',
        action: () => {
          if (state.focusedLaneId) focusLane(null);
          else {
            const first = bounded.lanes[0];
            if (first) focusLane(first.lane.lane_id);
          }
        },
      },
    ];
    for (const tool of tools) {
      const button = htmlEl(document, 'button', 'rails-tool', tool.text);
      button.setAttribute('aria-label', tool.label);
      button.setAttribute('type', 'button');
      button.addEventListener('click', tool.action);
      toolbar.appendChild(button);
    }
    return toolbar;
  }

  function renderBreadcrumbs() {
    setChildren(breadcrumbBar, []);
    if (!state.focusedLaneId || !tree) return;
    const path = breadcrumbPath(state.focusedLaneId, tree.byId);
    for (const crumb of path) {
      if (crumb.missing) {
        const placeholder = htmlEl(document, 'span', 'rails-crumb rails-crumb--orphan', `orphan:${crumb.lane_id}`);
        breadcrumbBar.appendChild(placeholder);
      } else {
        const button = htmlEl(document, 'button', 'rails-crumb', crumb.lane_id);
        button.setAttribute('type', 'button');
        const target = crumb.lane_id;
        button.addEventListener('click', () => focusLane(target));
        breadcrumbBar.appendChild(button);
      }
    }
  }

  function buildPane(bounded) {
    const pane = svgEl(document, 'svg', 'rails-svg');
    pane.setAttribute('role', 'application');
    pane.setAttribute('aria-label', 'Rails timeline');
    const laneCount = Math.max(bounded.lanes.length, 1);
    const paneH = laneCount * LANE_H + 120;
    pane.setAttribute('viewBox', `0 0 ${PANE_W} ${paneH}`);
    pane.setAttribute('tabindex', '0');

    viewport = svgEl(document, 'g', 'rails-viewport');
    applyTransform();
    pane.appendChild(viewport);

    const lanesWithMarks = bounded.lanes.filter((entry) => entry.visible > 0);
    let timeMin = Number.POSITIVE_INFINITY;
    let timeMax = Number.NEGATIVE_INFINITY;
    for (const entry of lanesWithMarks) {
      for (const mark of entry.marks) {
        if (mark.occurred_at == null) continue;
        const t = Date.parse(mark.occurred_at);
        if (!Number.isFinite(t)) continue;
        if (t < timeMin) timeMin = t;
        if (t > timeMax) timeMax = t;
      }
    }
    const hasExtent = Number.isFinite(timeMin) && Number.isFinite(timeMax) && timeMax > timeMin;
    const unknownX = LABEL_W + PAD + TIMELINE_W + 24;
    const isUnknownTime = (mark) =>
      !hasExtent || mark.occurred_at == null || !Number.isFinite(Date.parse(mark.occurred_at));
    if (bounded.lanes.some((entry) => entry.marks.some(isUnknownTime))) {
      const unknownHeader = svgEl(document, 'text', 'rails-unknown-column', 'unknown time');
      unknownHeader.setAttribute('x', String(unknownX));
      unknownHeader.setAttribute('y', '24');
      viewport.appendChild(unknownHeader);
    }

    bounded.lanes.forEach((entry, laneIndex) => {
      const lane = entry.lane;
      const laneY = laneIndex * LANE_H;
      const group = svgEl(document, 'g', `rail-lane ${laneClass(laneStatusLabel(lane.status))}`);
      group.setAttribute('data-lane-id', lane.lane_id);

      const sourceBadge = svgEl(document, 'text', `rail-source ${sourceClass(sourceStatusLabel(lane.source_status))}`, lane.source_status);
      sourceBadge.setAttribute('x', '8');
      sourceBadge.setAttribute('y', String(laneY + 16));
      group.appendChild(sourceBadge);

      const label = svgEl(document, 'text', 'rail-lane__label', lane.lane_id);
      label.setAttribute('x', '8');
      label.setAttribute('y', String(laneY + 38));
      group.appendChild(label);

      entry.marks.forEach((mark, markIndex) => {
        const rect = svgEl(document, 'rect', 'rail-mark');
        const classes = [`rail-mark--${outcomeClass(mark.outcome)}`];
        if (mark.ghost) classes.push('rail-mark--ghost');
        if (isUnknownTime(mark)) classes.push('rail-mark--unknown-time');
        for (const cls of classes) rect.classList.add(cls);
        rect.setAttribute('data-event-id', mark.event_id);
        rect.setAttribute('data-lane-id', lane.lane_id);
        rect.setAttribute('tabindex', '0');
        rect.setAttribute('role', 'button');
        rect.setAttribute('aria-label', markLabel(lane, mark));
        const x = isUnknownTime(mark)
          ? unknownX + (markIndex % 8) * (MARK_W + 6)
          : LABEL_W + PAD + ((Date.parse(mark.occurred_at) - timeMin) / (timeMax - timeMin || 1)) * TIMELINE_W;
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(laneY + 20));
        rect.setAttribute('width', String(MARK_W));
        rect.setAttribute('height', String(MARK_H));
        rect.setAttribute('rx', '3');
        rect.addEventListener('click', () => {
          selectByElement(rect);
          fireSelect(lane, mark);
        });
        group.appendChild(rect);
      });

      if (entry.omitted > 0) {
        const badge = svgEl(document, 'text', 'rails-truncated', `+${entry.omitted} hidden`);
        badge.setAttribute('x', String(PANE_W - 140));
        badge.setAttribute('y', String(laneY + 36));
        group.appendChild(badge);
      }

      viewport.appendChild(group);
    });

    pane.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = Math.exp(-Number(event.deltaY || 0) * 0.002);
      zoomBy(factor);
    });
    let dragging = null;
    pane.addEventListener('pointerdown', (event) => {
      dragging = { x: event.clientX, y: event.clientY };
    });
    pane.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      panBy(event.clientX - dragging.x, event.clientY - dragging.y);
      dragging = { x: event.clientX, y: event.clientY };
    });
    const endDrag = () => {
      dragging = null;
    };
    pane.addEventListener('pointerup', endDrag);
    pane.addEventListener('pointerleave', endDrag);

    return pane;
  }

  function applyTransform() {
    if (!viewport) return;
    viewport.setAttribute('transform', `translate(${state.tx} ${state.ty}) scale(${state.scale})`);
  }

  function applySelection() {
    state.ordered.forEach((entry, index) => {
      if (index === state.selectionIndex) entry.el.classList.add('rail-mark--selected');
      else entry.el.classList.remove('rail-mark--selected');
    });
    const current = state.ordered[state.selectionIndex];
    if (current && typeof current.el.focus === 'function') current.el.focus();
  }

  function selectByElement(el) {
    const index = state.ordered.findIndex((entry) => entry.el === el);
    if (index >= 0) {
      state.selectionIndex = index;
      applySelection();
    }
  }

  function fireSelect(lane, mark) {
    const crumbs = tree ? breadcrumbPath(lane.lane_id, tree.byId) : [];
    onSelect({ lane, mark, breadcrumbs: crumbs });
  }

  function zoomBy(factor) {
    state.scale = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);
    applyTransform();
  }

  function panBy(dx, dy) {
    state.tx = clamp(state.tx + dx, -PAN_LIMIT, PAN_LIMIT);
    state.ty = clamp(state.ty + dy, -PAN_LIMIT, PAN_LIMIT);
    applyTransform();
  }

  function resetView() {
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    applyTransform();
  }

  function focusLane(laneId) {
    if (state.destroyed) return;
    if (laneId == null) {
      state.focusedLaneId = null;
    } else if (tree && tree.byId.has(laneId)) {
      state.focusedLaneId = laneId;
    } else {
      return;
    }
    render();
  }

  function handleKeydown(event) {
    if (state.destroyed || state.ordered.length === 0) return;
    const key = event.key;
    if (key === 'ArrowRight') {
      event.preventDefault();
      state.selectionIndex = (state.selectionIndex + 1) % state.ordered.length;
      applySelection();
    } else if (key === 'ArrowLeft') {
      event.preventDefault();
      state.selectionIndex = (state.selectionIndex - 1 + state.ordered.length) % state.ordered.length;
      applySelection();
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      const current = state.ordered[state.selectionIndex];
      const currentIndex = current ? view.lanes.indexOf(current.lane) : -1;
      const visibleLanesNow = byClassWithin(container, 'rail-lane');
      const step = key === 'ArrowDown' ? 1 : -1;
      let target = -1;
      for (let offset = 1; offset <= visibleLanesNow.length; offset += 1) {
        const candidateIndex = (currentIndex + step * offset + view.lanes.length * 2) % view.lanes.length;
        const candidate = state.ordered.find((entry) => entry.lane === view.lanes[candidateIndex]);
        if (candidate) {
          target = state.ordered.indexOf(candidate);
          break;
        }
      }
      if (target >= 0) {
        state.selectionIndex = target;
        applySelection();
      }
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      const current = state.ordered[state.selectionIndex];
      if (current) fireSelect(current.lane, current.mark);
    } else if (key === '+' || key === '=') {
      event.preventDefault();
      zoomBy(1.25);
    } else if (key === '-' || key === '_') {
      event.preventDefault();
      zoomBy(0.8);
    } else if (key === '0') {
      event.preventDefault();
      resetView();
    } else if (key === 'f' || key === 'F') {
      event.preventDefault();
      if (state.focusedLaneId) focusLane(null);
      else {
        const first = boundMarksForView({ lanes: view.lanes }, caps).lanes[0];
        if (first) focusLane(first.lane.lane_id);
      }
    } else if (key === 'Escape') {
      if (state.focusedLaneId) focusLane(null);
      else {
        state.selectionIndex = -1;
        applySelection();
      }
    }
  }

  container.addEventListener('keydown', handleKeydown);

  Object.assign(app, {
    getTransform: () => ({ scale: state.scale, tx: state.tx, ty: state.ty }),
    zoomBy,
    panBy,
    resetView,
    focusLane,
    getFocusedLaneId: () => state.focusedLaneId,
    setView(nextView) {
      const result = validateView(nextView);
      if (!result.ok) {
        view = nextView;
        validation = result;
        app.error = result.errors;
        tree = null;
        renderErrorState();
        return app;
      }
      view = nextView;
      validation = result;
      app.error = null;
      tree = buildLaneTree(view);
      state.focusedLaneId = null;
      render();
      return app;
    },
    destroy() {
      state.destroyed = true;
      setChildren(container, []);
    },
  });

  return app;
}

export function bootObservatory() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rails-root');
  if (!root) return null;
  const inspectorHost = document.getElementById('rails-inspector') || root;
  const inspector = createInspector({ container: inspectorHost, document });
  const app = createObservatory({
    container: root,
    view: SAMPLE_VIEW,
    document,
    reducedMotion:
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false,
    onSelect: (ctx) => inspector.show({ lane: ctx.lane, mark: ctx.mark, breadcrumbs: ctx.breadcrumbs }),
  });
  const tryLoad = () => {
    if (typeof fetch !== 'function') return;
    fetch('rails-view.json')
      .then((response) => {
        if (!response.ok) throw new Error(`rails-view fetch failed: ${response.status}`);
        return response.json();
      })
      .then((view) => {
        app.setView(view);
      })
      .catch(() => {
        app.setView(SAMPLE_VIEW);
      });
  };
  if (typeof window !== 'undefined' && window.RAILS_VIEW) app.setView(window.RAILS_VIEW);
  else tryLoad();
  return { app, inspector };
}
