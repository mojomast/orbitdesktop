export const RAILS_VIEW_SCHEMA = 'rizzstack.rails-view/1';

export const CAPS = { perLane: 500, total: 2000, lanes: 500 };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const OUTCOME_RE = /^[A-Za-z0-9_:-]{1,80}$/;
const MISSING_SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

const LANE_STATUSES = ['open', 'closed', 'orphan', 'ghost', 'unknown'];
const SOURCE_STATUSES = ['live', 'stale', 'unavailable', 'unknown'];
const TIMING_QUALITIES = ['measured', 'estimated', 'unknown'];
const COMPLETENESS_VALUES = ['complete', 'partial', 'empty'];
const INTEGRITY_STATUSES = ['unchecked', 'ok', 'failed'];

const MAX_DURATION_MS = 9007199254740991;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function checkEnum(errors, where, value, allowed) {
  if (!allowed.includes(value)) errors.push(`${where} must be one of ${allowed.join(', ')}`);
}

function checkId(errors, where, value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    errors.push(`${where} must match ${String(ID_RE)}`);
  }
}

function validateMark(mark, errors, where) {
  if (!isObject(mark)) {
    errors.push(`${where} must be an object`);
    return;
  }
  for (const key of ['event_id', 'kind', 'occurred_at', 'duration_ms', 'timing_quality', 'outcome', 'evidence_refs', 'ghost']) {
    if (!Object.prototype.hasOwnProperty.call(mark, key)) errors.push(`${where} is missing required field ${key}`);
  }
  for (const key of Object.keys(mark)) {
    if (!['event_id', 'kind', 'occurred_at', 'duration_ms', 'timing_quality', 'outcome', 'evidence_refs', 'ghost'].includes(key)) {
      errors.push(`${where} has unknown field ${key}`);
    }
  }
  checkId(errors, `${where}.event_id`, mark.event_id);
  checkId(errors, `${where}.kind`, mark.kind);
  if (mark.occurred_at !== null && mark.occurred_at !== undefined) {
    if (typeof mark.occurred_at !== 'string' || !TIMESTAMP_RE.test(mark.occurred_at)) {
      errors.push(`${where}.occurred_at must be null or match ${String(TIMESTAMP_RE)}`);
    }
  } else if (mark.occurred_at === undefined) {
    errors.push(`${where}.occurred_at must be present (null when unknown)`);
  }
  if (mark.duration_ms !== null && mark.duration_ms !== undefined) {
    if (!Number.isInteger(mark.duration_ms) || mark.duration_ms < 0 || mark.duration_ms > MAX_DURATION_MS) {
      errors.push(`${where}.duration_ms must be null or an integer within [0, ${MAX_DURATION_MS}]`);
    }
  } else if (mark.duration_ms === undefined) {
    errors.push(`${where}.duration_ms must be present (null when unknown)`);
  }
  checkEnum(errors, `${where}.timing_quality`, mark.timing_quality, TIMING_QUALITIES);
  if (mark.outcome !== null && mark.outcome !== undefined) {
    if (typeof mark.outcome !== 'string' || !OUTCOME_RE.test(mark.outcome)) {
      errors.push(`${where}.outcome must be null or match ${String(OUTCOME_RE)}`);
    }
  } else if (mark.outcome === undefined) {
    errors.push(`${where}.outcome must be present (null when unknown)`);
  }
  if (!Array.isArray(mark.evidence_refs)) {
    errors.push(`${where}.evidence_refs must be an array`);
  } else {
    if (mark.evidence_refs.length > 20) errors.push(`${where}.evidence_refs must have at most 20 entries`);
    mark.evidence_refs.forEach((ref, index) => checkId(errors, `${where}.evidence_refs[${index}]`, ref));
  }
  if (typeof mark.ghost !== 'boolean') errors.push(`${where}.ghost must be a boolean`);
}

function validateLane(lane, errors, index) {
  const where = `lanes[${index}]`;
  if (!isObject(lane)) {
    errors.push(`${where} must be an object`);
    return;
  }
  for (const key of ['lane_id', 'parent_lane_id', 'status', 'source_status', 'marks']) {
    if (!Object.prototype.hasOwnProperty.call(lane, key)) errors.push(`${where} is missing required field ${key}`);
  }
  for (const key of Object.keys(lane)) {
    if (!['lane_id', 'parent_lane_id', 'status', 'source_status', 'marks'].includes(key)) {
      errors.push(`${where} has unknown field ${key}`);
    }
  }
  checkId(errors, `${where}.lane_id`, lane.lane_id);
  if (lane.parent_lane_id !== null && lane.parent_lane_id !== undefined) {
    checkId(errors, `${where}.parent_lane_id`, lane.parent_lane_id);
  } else if (lane.parent_lane_id === undefined) {
    errors.push(`${where}.parent_lane_id must be present (null for a root lane)`);
  }
  checkEnum(errors, `${where}.status`, lane.status, LANE_STATUSES);
  checkEnum(errors, `${where}.source_status`, lane.source_status, SOURCE_STATUSES);
  if (!Array.isArray(lane.marks)) {
    errors.push(`${where}.marks must be an array`);
  } else {
    if (lane.marks.length > 500) errors.push(`${where}.marks must have at most 500 entries`);
    lane.marks.forEach((mark, markIndex) => validateMark(mark, errors, `${where}.marks[${markIndex}]`));
  }
}

export function validateView(view) {
  const errors = [];
  if (!isObject(view)) {
    return { ok: false, errors: ['view must be an object'] };
  }
  for (const key of ['schema', 'generated_at', 'lanes', 'completeness', 'missing_sources', 'integrity']) {
    if (!Object.prototype.hasOwnProperty.call(view, key)) errors.push(`view is missing required field ${key}`);
  }
  for (const key of Object.keys(view)) {
    if (!['schema', 'generated_at', 'lanes', 'completeness', 'missing_sources', 'integrity'].includes(key)) {
      errors.push(`view has unknown field ${key}`);
    }
  }
  if (view.schema !== RAILS_VIEW_SCHEMA) errors.push(`view.schema must be ${RAILS_VIEW_SCHEMA}`);
  if (typeof view.generated_at !== 'string' || !TIMESTAMP_RE.test(view.generated_at)) {
    errors.push(`view.generated_at must match ${String(TIMESTAMP_RE)}`);
  }
  if (!Array.isArray(view.lanes)) {
    errors.push('view.lanes must be an array');
  } else {
    if (view.lanes.length > 500) errors.push('view.lanes must have at most 500 entries');
    view.lanes.forEach((lane, index) => validateLane(lane, errors, index));
  }
  checkEnum(errors, 'view.completeness', view.completeness, COMPLETENESS_VALUES);
  if (!Array.isArray(view.missing_sources)) {
    errors.push('view.missing_sources must be an array');
  } else {
    if (view.missing_sources.length > 50) errors.push('view.missing_sources must have at most 50 entries');
    view.missing_sources.forEach((source, index) => {
      if (typeof source !== 'string' || !MISSING_SOURCE_RE.test(source)) {
        errors.push(`view.missing_sources[${index}] must match ${String(MISSING_SOURCE_RE)}`);
      }
    });
  }
  if (!isObject(view.integrity)) {
    errors.push('view.integrity must be an object');
  } else {
    for (const key of ['status', 'checked_through']) {
      if (!Object.prototype.hasOwnProperty.call(view.integrity, key)) {
        errors.push(`view.integrity is missing required field ${key}`);
      }
    }
    for (const key of Object.keys(view.integrity)) {
      if (!['status', 'checked_through'].includes(key)) errors.push(`view.integrity has unknown field ${key}`);
    }
    checkEnum(errors, 'view.integrity.status', view.integrity.status, INTEGRITY_STATUSES);
    const checked = view.integrity.checked_through;
    if (checked !== null && typeof checked !== 'string') {
      errors.push('view.integrity.checked_through must be a string or null');
    } else if (typeof checked === 'string' && checked.length > 256) {
      errors.push('view.integrity.checked_through must be at most 256 characters');
    }
  }
  return { ok: errors.length === 0, errors };
}

export function buildLaneIndex(view) {
  const lanes = Array.isArray(view && view.lanes) ? view.lanes : [];
  const index = new Map();
  for (const lane of lanes) {
    if (isObject(lane) && typeof lane.lane_id === 'string') index.set(lane.lane_id, lane);
  }
  return index;
}

export function buildLaneTree(view) {
  const lanes = Array.isArray(view && view.lanes) ? view.lanes : [];
  const byId = new Map();
  const nodes = new Map();
  for (const lane of lanes) {
    if (!isObject(lane) || typeof lane.lane_id !== 'string') continue;
    if (nodes.has(lane.lane_id)) continue;
    const node = { lane, children: [], orphan: false, cycled: false };
    nodes.set(lane.lane_id, node);
    byId.set(lane.lane_id, node);
  }
  const roots = [];
  const orphans = [];
  for (const node of nodes.values()) {
    const parentId = node.lane.parent_lane_id;
    if (parentId === null || parentId === undefined) {
      roots.push(node);
    } else {
      const parent = nodes.get(parentId);
      if (parent) parent.children.push(node);
      else {
        node.orphan = true;
        orphans.push(node.lane.lane_id);
        roots.push(node);
      }
    }
  }

  const cycles = [];
  const seenCycleKeys = new Set();
  const color = new Map();
  const stack = [];
  const visit = (id) => {
    const state = color.get(id) || 0;
    if (state === 1) {
      const start = stack.indexOf(id);
      const cycle = stack.slice(start >= 0 ? start : 0);
      const key = [...cycle].sort().join('|');
      if (!seenCycleKeys.has(key) && cycle.length > 0) {
        seenCycleKeys.add(key);
        cycles.push([...cycle]);
        for (const cycleId of cycle) {
          const cycleNode = nodes.get(cycleId);
          if (cycleNode) cycleNode.cycled = true;
        }
      }
      return;
    }
    if (state === 2) return;
    color.set(id, 1);
    stack.push(id);
    const node = nodes.get(id);
    for (const child of node.children) visit(child.lane.lane_id);
    stack.pop();
    color.set(id, 2);
  };
  for (const id of nodes.keys()) visit(id);

  for (const cycle of cycles) {
    for (const cycleId of cycle) {
      const node = nodes.get(cycleId);
      if (!node) continue;
      for (const other of nodes.values()) {
        const childIndex = other.children.indexOf(node);
        if (childIndex >= 0) other.children.splice(childIndex, 1);
      }
      if (!roots.includes(node)) roots.push(node);
    }
  }

  return { roots, byId, orphans, cycles };
}

export function boundMarksForView(viewLike, caps = CAPS) {
  const lanes = Array.isArray(viewLike && viewLike.lanes) ? viewLike.lanes : [];
  const perLaneCap = caps && Number.isInteger(caps.perLane) ? caps.perLane : CAPS.perLane;
  const totalCap = caps && Number.isInteger(caps.total) ? caps.total : CAPS.total;
  const laneCap = caps && Number.isInteger(caps.lanes) ? caps.lanes : CAPS.lanes;
  const laneSlice = lanes.slice(0, laneCap);
  const lanesHidden = Math.max(lanes.length - laneSlice.length, 0);
  let totalHidden = 0;
  for (const lane of lanes.slice(laneCap)) {
    totalHidden += Array.isArray(lane && lane.marks) ? lane.marks.length : 0;
  }
  let budget = totalCap;
  let totalVisible = 0;
  const outLanes = laneSlice.map((lane) => {
    const marks = Array.isArray(lane && lane.marks) ? lane.marks : [];
    const take = Math.max(Math.min(perLaneCap, marks.length, Math.max(budget, 0)), 0);
    budget -= take;
    totalVisible += take;
    totalHidden += marks.length - take;
    return { lane, marks: marks.slice(0, take), visible: take, omitted: marks.length - take };
  });
  return {
    lanes: outLanes,
    totalVisible,
    totalHidden,
    lanesVisible: laneSlice.length,
    lanesHidden,
  };
}

export function breadcrumbPath(laneId, index) {
  const path = [];
  let current = laneId;
  let guard = 0;
  while (current !== null && current !== undefined && guard < 1000) {
    guard += 1;
    const entry = index instanceof Map ? index.get(current) : null;
    const lane = entry && entry.lane && Array.isArray(entry.children) ? entry.lane : entry;
    if (lane) {
      path.push({ lane_id: current, missing: false });
      current = lane.parent_lane_id;
    } else {
      path.push({ lane_id: current, missing: true });
      current = null;
    }
  }
  return path.reverse();
}

export function outcomeClass(outcome) {
  if (outcome === null || outcome === undefined || outcome === '') return 'unknown';
  const normalized = String(outcome).toLowerCase();
  if (normalized === 'expected_red' || normalized === 'red' || normalized.startsWith('red')) return 'red';
  if (normalized === 'not_run') return 'unrun';
  if (/(fail|error|timeout|crash|abort)/.test(normalized)) return 'failure';
  if (/(pass|ok|success|green|done|complete)/.test(normalized)) return 'ok';
  return 'other';
}

export function laneClass(status) {
  return LANE_STATUSES.includes(status) ? `rail-lane--${status}` : 'rail-lane--unknown';
}

export function sourceClass(status) {
  return SOURCE_STATUSES.includes(status) ? `rail-source--${status}` : 'rail-source--unknown';
}

export function formatTimestamp(timestamp) {
  return timestamp === null || timestamp === undefined ? 'unknown' : String(timestamp);
}

export function formatDuration(durationMs) {
  return durationMs === null || durationMs === undefined ? 'unknown' : `${durationMs} ms`;
}
