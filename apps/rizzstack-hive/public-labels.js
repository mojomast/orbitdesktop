// Trusted producer/host projection, not a source field, authority or reader.
import {project} from './snapshot-adapter.js';

const VERSION = 'hive.public-labels/1', DRAFT = 'hive.public-aliases/1';
const FRESH = 600_000, SKEW = 60_000, REVIEW_WINDOW = 24 * 60 * 60_000;
const scopes = new WeakMap(); // Local to the trusted projection. Never add these facts to a view.
const refuse = () => { throw new TypeError('Invalid public label publication'); };
const sensitiveWords = /(?:private|secret|credential|password|passwd|passphrase|confidential|bearer|token|api[ _-]?key|access[ _-]?key|localhost|internal|redacted|transcript|address|ssh[ _-]?key|mnemonic|oauth)/i;
const unsafeToken = /^(?:unknown$|constructor$|prototype$|AKIA|ASIA|gh[pousr]_|github_pat_|sk[-_]|rk[-_]|glpat-|xox[baprs]-|eyJ|pk_live_|AIza)/i;
const id = s => typeof s === 'string' && s.length <= 64 && !/[^a-zA-Z0-9_-]/.test(s) &&
  /^[a-zA-Z][a-zA-Z0-9]{0,23}(?:[-_][a-zA-Z0-9]{1,24})*$/.test(s) && !sensitiveWords.test(s) && !unsafeToken.test(s);
const repo = s => typeof s === 'string' && s.length <= 129 && s.split('/').length === 2 && s.split('/').every(id);
const title = s => typeof s === 'string' && s.length <= 64 && !/[^a-zA-Z ]/.test(s) &&
  s.split(' ').length <= 8 && s.split(' ').every(w => /^(?:[A-Z]?[a-z]{1,15}|[A-Z]{1,4})$/.test(w)) && !sensitiveWords.test(s);
const digest = s => typeof s === 'string' && s.length === 64 && !/[^a-f0-9]/.test(s);
const baseRev = s => digest(s) || (typeof s === 'string' && s.length === 40 && !/[^a-f0-9]/.test(s));
const utc = s => typeof s === 'string' && s.length === 24 && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const key = r => `${r.kind}:${r.id}`;
const identity = r => (r.kind === 'job' ? r.id === r.jobId : r.kind === 'backlog') && id(r.id) && id(r.jobId) && repo(r.repo);

// Both boundaries accept parsed data only. Refuse extra (even non-enumerable)
// keys, sparse/subclassed arrays, inherited facts and accessors without reading them.
function dataProperty(value, name) {
  const d = Object.getOwnPropertyDescriptor(value, name);
  return d?.enumerable && Object.hasOwn(d, 'value');
}
function shape(v, names) {
  if (!v || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) return false;
  return Reflect.ownKeys(v).length === names.length && names.every(k => dataProperty(v,k));
}
function rows(value, published) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 64 ||
      Reflect.ownKeys(value).length !== value.length + 1) return false;
  const keys = ['kind','id','repo','jobId','title'];
  if (published) keys.push('revision');
  const seen = new Set();
  for (let i = 0; i < value.length; i++) {
    if (!dataProperty(value,i)) return false;
    const r = value[i];
    if (!shape(r,keys) || !identity(r) || !title(r.title) || (published && !digest(r.revision)) || seen.has(key(r))) return false;
    seen.add(key(r));
  }
  return true;
}

export function validateLabels(v) {
  try {
    return shape(v,['version','reviewedAt','rows']) && v.version === VERSION && utc(v.reviewedAt) && rows(v.rows,true);
  } catch { return false; }
}

const sha = async text => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),
  b => b.toString(16).padStart(2,'0')).join('');
const byId = (a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
function freeze(o) {
  if (o && typeof o === 'object') {
    for (const x of Object.values(o)) freeze(x);
    Object.freeze(o);
  }
  return o;
}

// The one projection call is the admission boundary. Only visible, measured
// rows may acquire bindings; never parse display prose for repo or revision.
// Hash a closed, typed *public* tuple, not the source file (even a digest of a
// private question is information about it). Sampling clocks govern freshness,
// not revision; the collector regenerates them even on a no-change read.
export async function projectLabelView(snapshot, {now = Date.now()} = {}) {
  const view = freeze(project(snapshot,{now}));
  const bindings = new Map();
  scopes.set(view,{base:view,bindings});
  if (!globalThis.crypto?.subtle) return view;
  const live = section => view.sections.some(r => r.id === section && r.state === 'live');
  if (!live('pipeline')) return view;
  const records = new Map(view.records.map(r => [r.id,r]));
  const observed = Math.min(Date.parse(view.generatedAt), Date.parse(snapshot.pipeline.collected_at));
  const jobs = new Map(), hashes = [];
  function bind(r, tuple, oldest) {
    const text = JSON.stringify([VERSION,...tuple]); // capture before the first await
    hashes.push(sha(text).then(revision => bindings.set(key(r),{...r,revision,expires:oldest+FRESH})));
  }
  for (const j of snapshot.pipeline.jobs) {
    const jobId = j.job_id, slug = j.repo, r = records.get(`job:${jobId}`);
    if (!r || r.kind !== 'job' || r.source !== 'snapshot/1:pipeline' || r.jobId !== jobId || r.state !== 'recorded' ||
        !id(jobId) || !repo(slug) || !baseRev(j.base_rev) || j.tasks.length > 64 || j.task_count !== j.tasks.length) continue;
    let oldest = Math.min(observed,Date.parse(j.generated_at));
    const tasks = [];
    for (const t of j.tasks) {
      const at = Date.parse(t.generated_at);
      if (!id(t.task_id) || at < now-FRESH || at > now+SKEW) break;
      oldest = Math.min(oldest,at);
      tasks.push([t.task_id,t.state,t.attempts_count]);
    }
    if (tasks.length !== j.tasks.length) continue;
    const tuple = ['snapshot/1:pipeline',slug,jobId,j.base_rev,j.task_count,j.escalation_count,tasks.sort(byId)];
    jobs.set(jobId,{tuple,oldest,repo:slug});
    bind({kind:'job',id:jobId,jobId,repo:slug},tuple,oldest);
  }
  if (live('backlog')) for (const f of snapshot.backlog.features) {
    const objectId = f.feature_id, jobId = f.job_id, j = jobs.get(jobId), r = records.get(`backlog:${objectId}`);
    if (!j || !r || r.kind !== 'backlog' || r.source !== 'snapshot/1:backlog' || r.jobId !== jobId || r.state !== f.status ||
        !id(objectId) || f.depends_on.length > 32 || !f.depends_on.every(id) || new Set(f.depends_on).size !== f.depends_on.length) continue;
    bind({kind:'backlog',id:objectId,jobId,repo:j.repo},
      ['snapshot/1:backlog',objectId,jobId,f.status,[...f.depends_on].sort(),j.tuple],
      Math.min(j.oldest,Date.parse(snapshot.backlog.collected_at),Date.parse(f.generated_at)));
  }
  await Promise.all(hashes);
  return view;
}

// Publisher helper for the trusted local CLI; snapshotSha256 is the SHA-256
// already recomputed over the exact reviewed bytes. Neither input pin leaves it.
export async function publishLabels(snapshot, draft, snapshotSha256, {now = Date.now()} = {}) {
  if (!shape(draft,['version','snapshotSha256','rows']) || draft.version !== DRAFT || !digest(snapshotSha256) ||
      snapshotSha256 !== draft.snapshotSha256 || !rows(draft.rows,false)) refuse();
  const selections = draft.rows.map(r => ({...r}));
  const view = await projectLabelView(snapshot,{now});
  const bindings = scopes.get(view).bindings;
  return {version:VERSION, reviewedAt:new Date(view.generatedAt).toISOString(), rows: selections.map(r => {
    const hit = bindings.get(key(r));
    if (!hit || hit.repo !== r.repo || hit.jobId !== r.jobId) refuse();
    return {...r,revision:hit.revision};
  })};
}

// A result is always derived from the original baseline, including on revoke.
// Only titles can differ. Catalog identities never create new records or joins.
export function applyLabels(view, packet, {now = Date.now()} = {}) {
  const scope = scopes.get(view), base = scope?.base ?? view;
  const admitted = new Map();
  if (scope && validateLabels(packet) && Number.isFinite(now)) {
    const at = Date.parse(base.generatedAt), reviewed = Date.parse(packet.reviewedAt);
    if (now >= at-SKEW && at >= reviewed && now <= reviewed+REVIEW_WINDOW) {
      for (const row of packet.rows) {
        const b = scope.bindings.get(key(row));
        if (b && b.expires >= now && b.revision === row.revision && b.repo === row.repo && b.jobId === row.jobId) admitted.set(key(row),row.title);
      }
    }
  }
  const result = {...base, records:base.records.map(r => admitted.has(r.id) ? {...r,title:admitted.get(r.id)} : r)};
  if (scope) scopes.set(result,scope);
  return result;
}
