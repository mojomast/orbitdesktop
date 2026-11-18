import { capture } from './queue-data.js';

const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha = /^[0-9a-f]{64}$/;
const ac = /^AC-[0-9]{3}$/;
const time = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/;
const valid = (value, pattern) => typeof value === 'string' && value.length <= 160 && pattern.test(value);
const list = (value, pattern) => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(v => valid(v, pattern));

// Consume bounded public projections; the BundleBees reader owns the verdict.
export function queueFacts(input) {
  const c = input?.coverage;
  const w = input?.work;
  const overlap = w?.source === 'bundlebees.work-scheduler/1' && w.state === 'pending' &&
    valid(w.id, id) && list(w.overlap_ids, id) ? `${w.id} overlaps a claimed file scope: ${w.overlap_ids.join(', ')}` : 'Unknown';
  if (!c || c.suggestion !== true || c.queue_mutated !== false || c.classification !== 'PARTIAL' ||
      c.reason !== 'retained_return_at_observed_open_draft_head' || c.queue_state !== 'queued' ||
      !valid(c.feature_id, id) || !valid(c.job_id, id) || !valid(c.head, /^[0-9a-f]{40}$/) || c.head !== input.candidate ||
      !valid(c.pr_url, /^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/pull\/[1-9][0-9]{0,8}$/) ||
      !valid(c.pr_observed_at, time) || ![c.green_sha256, c.return_sha256, c.contract_sha256].every(s => valid(s, sha)) ||
      !list(c.covered, ac) || !list(c.missing, ac) || new Set([...c.covered, ...c.missing]).size !== c.covered.length + c.missing.length) {
    return { verdict: 'UNKNOWN', overlap };
  }
  return { verdict: 'PARTIAL', overlap, rows: [
    ['Feature / job', `${c.feature_id} / ${c.job_id}`], ['Recorded feature state', c.queue_state],
    ['Criteria with evidence', `${c.covered.length} of ${c.covered.length + c.missing.length}: ${c.covered.join(', ')}`],
    ['Missing evidence', c.missing.join(', ')], ['Simulated draft (offline reference)', c.pr_url.replace('https://github.com/', '')],
    ['Observed PR head', c.head], ['Observed at', c.pr_observed_at], ['Frozen contract SHA-256', c.contract_sha256],
    ['GREEN SHA-256', c.green_sha256], ['RETURN SHA-256', c.return_sha256],
  ] };
}

export function renderQueueDesk(container, { demo } = {}) {
  const node = (tag, value = '', className = '') => {
    const el = container.ownerDocument.createElement(tag);
    el.className = className;
    el.textContent = value;
    return el;
  };
  const body = node('div', '', 'release-body');
  if (demo !== true) {
    body.append(node('h2', 'Queue evidence unavailable'), node('p', 'DISCONNECTED · No authorized queue reader is enrolled.'));
    container.replaceChildren(body);
    return;
  }
  const result = queueFacts(capture);
  const head = node('header', '', 'sheet-head');
  head.append(node('h2', 'Draft coverage'), node('span', 'DISCONNECTED DEMO', 'tag'));
  body.append(head, node('p', 'This simulated draft pairs a local Git candidate with evidence from a temporary BundleBees job.'),
    node('h3', `${result.verdict} · reconciliation suggestion`), node('p', 'The feature queue was not changed.'));
  if (result.rows) {
    const facts = node('dl', '', 'facts');
    for (const [key, value] of result.rows) {
      const pair = node('div');
      pair.append(node('dt', key), node('dd', value));
      facts.append(pair);
    }
    body.append(facts);
  } else {
    body.append(node('p', 'Matching draft head and named criterion evidence are unavailable.'));
  }
  body.append(node('h3', 'Scheduler file overlap'), node('p', result.overlap),
    node('p', 'Dispatch disabled: a queue executor is not enrolled. A coverage suggestion cannot authorize another attempt.'));
  container.replaceChildren(body);
}
