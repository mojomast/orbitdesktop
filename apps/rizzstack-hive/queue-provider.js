// hive.queue/1: plain JSON in, a historical observation out. The host enforces
// the 64 KiB wire limit before JSON parsing. This module has no capabilities.
const keys = (obj, names) => {
  if (obj === null || typeof obj !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(obj))) return false;
  return Reflect.ownKeys(obj).length === names.length && names.every(k => {
    const d = Object.getOwnPropertyDescriptor(obj, k);
    return d?.enumerable && Object.hasOwn(d, 'value');
  });
};
const id = s => typeof s === 'string' && s.length >= 1 && s.length <= 64 &&
  /^[A-Za-z0-9]/.test(s) && !/[^A-Za-z0-9_-]/.test(s);
const hex = (s, n) => typeof s === 'string' && s.length === n && !/[^a-f0-9]/.test(s);
const iso = s => {
  if (typeof s !== 'string' || s.length !== 20 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(s)) return false;
  const ms = Date.parse(s);
  return s.slice(0, 4) !== '0000' && Number.isFinite(ms) && new Date(ms).toISOString() === s.slice(0,-1) + '.000Z';
};
const states = ['claimed','running','ready_for_review','needs_approval','failed','blocked','unknown'];
const count = n => Number.isInteger(n) && n >= 1 && n <= 256;

export function validateQueue(value) {
  if (!keys(value,['version','subject','observedAt','queue','scheduler','lease','coverage']) || value.version !== 'hive.queue/1') return false;
  const {subject,observedAt,queue,scheduler,lease,coverage} = value;
  if (!keys(subject,['featureId','jobId']) || !id(subject.featureId) || !id(subject.jobId) ||
      !iso(observedAt) || Date.parse(observedAt) > Date.now() + 30000) return false;
  if (!keys(queue,['state','updatedAt','sha256']) || !states.includes(queue.state) || !hex(queue.sha256,64) ||
      !(queue.updatedAt === null || iso(queue.updatedAt))) return false;
  if (!keys(scheduler,['state','sha256','overlap'])) return false;
  if (scheduler.state === 'unknown') {
    if (scheduler.sha256 !== null || scheduler.overlap !== 'unknown') return false;
  } else if (!['pending','blocked','claimed','done'].includes(scheduler.state) || !hex(scheduler.sha256,64) ||
      !['recorded','none','unknown'].includes(scheduler.overlap)) return false;
  if (!keys(lease,['state','sha256']) || !(lease.state === 'recorded' ? hex(lease.sha256,64) :
      lease.state === 'unknown' && lease.sha256 === null)) return false;
  if (!keys(coverage,['state','sha256','verificationSha256','head','covered','total'])) return false;
  const {state,sha256,verificationSha256,head,covered,total} = coverage;
  if (state === 'UNKNOWN') return [sha256,verificationSha256,head,covered,total].every(v=>v === null);
  return ['PARTIAL','COVERED_BY_DRAFT','LANDED'].includes(state) && lease.state === 'recorded' &&
    hex(sha256,64) && hex(verificationSha256,64) && hex(head,40) && count(covered) && count(total) &&
    (state === 'PARTIAL' ? covered < total : covered === total);
}

export function renderQueueDocket(root, value) {
  const make = (tag,text) => {
    const el = root.ownerDocument.createElement(tag);
    el.textContent = text;
    return el;
  };
  if (!validateQueue(value)) {
    root.replaceChildren(make('p','Queue evidence unavailable.'));
    return;
  }
  const {subject,observedAt,queue,scheduler,lease,coverage} = value;
  const stale = Date.now() - Date.parse(observedAt) > 300000;
  const meanings = {UNKNOWN:'Insufficient linked evidence.', PARTIAL:'Draft covers part of the job scope.',
    COVERED_BY_DRAFT:'Draft covers the job scope; review and merge remain separate.',
    LANDED:'Reconciliation records a merged candidate for this scope.'};
  const body = make('section','');
  body.className = 'release-body';
  body.append(make('h2','Selected coordinator docket'), make('p',`${subject.featureId} / ${subject.jobId}`),
    make('p',`${stale ? 'Stale observation' : 'Observed'} · ${observedAt}`),
    make('p',`Recorded queue state: ${queue.state}. Last queue update: ${queue.updatedAt ?? 'unknown'}.`),
    make('p',`Scheduler: ${scheduler.state}. Claimed file overlap in this snapshot: ${scheduler.overlap}.`),
    make('p',`Signed lease record: ${lease.state}. A recorded lease does not establish current ownership.`),
    make('h3',coverage.state), make('p',meanings[coverage.state]));
  if (coverage.head) body.append(make('p',`${coverage.covered} of ${coverage.total} assigned files. Verified head: ${coverage.head}.`));
  body.append(make('p','This observation does not authorize dispatch, acceptance or merge.'));
  const sources = make('details','');
  sources.append(make('summary','Source SHA-256 digests'));
  for (const [label, hash] of [['Feature',queue.sha256],['Scheduler',scheduler.sha256],['Lease',lease.sha256],
      ['Reconciliation',coverage.sha256],['Verifier',coverage.verificationSha256]]) {
    if (hash) sources.append(make('p',`${label}: ${hash}`));
  }
  body.append(sources);
  root.replaceChildren(body);
}
