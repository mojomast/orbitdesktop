// Public companion report from scripts/hive_release_read.py. No network,
// storage, executable actions or implicit fallback to the #92 reference packet.
const enrollment = [
  ['mojomast/workflow', 1455472841, 91],
  ['mojomast/bundlebees', 1454339884, 82],
  ['mojomast/hyvv', 1455851481, 26],
  ['mojomast/orbitdesktop', 1377703993, 46],
];
const CAPTURE_MS = 90_000;
const STALE_MS = 15 * 60_000;
const own = (v, names) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const list = (v, n) => Array.isArray(v) && v.length === n && Object.keys(v).length === n &&
  Array.from({length:n}, (_, i) => Object.hasOwn(v, i)).every(Boolean);
const sha = s => typeof s === 'string' && s.length === 40 && /^[a-f0-9]{40}$/.test(s) && s !== '0'.repeat(40);
const revision = s => s === null || sha(s);
const count = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
function instant(s) {
  if (typeof s !== 'string' || s.length !== 24 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)) return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s ? t : NaN;
}

/** Validate JSON before transfer and again at display. Stale is valid historical evidence. */
export function validateRelease(value) {
  if (!own(value, ['schema','startedAt','observedAt','repos']) || value.schema !== 'hive-release-read/1' ||
      !list(value.repos, enrollment.length)) return false;
  const start = instant(value.startedAt), end = instant(value.observedAt);
  if (!(start <= end && end - start <= CAPTURE_MS && end <= Date.now())) return false;
  let last = start;
  const readAt = at => {
    const t = instant(at);
    if (!(last <= t && t <= end)) return false;
    last = t;
    return true;
  };
  const outcomes = ['success','failure','skipped','neutral','pending'];
  function checks(c, expected) {
    return own(c, ['at','sha','total','sampled','truncated', ...outcomes]) && readAt(c.at) && c.sha === expected &&
      count(c.total, 1_000_000) && count(c.sampled, Math.min(c.total, 50)) && c.truncated === (c.sampled < c.total) &&
      outcomes.every(key => count(c[key], c.sampled)) && outcomes.reduce((n, k) => n + c[k], 0) === c.sampled;
  }
  for (const [i, [name, rid, n]] of enrollment.entries()) {
    const r = value.repos[i];
    if (!own(r, ['repo','repoId','at','main','prs']) || r.repo !== name || r.repoId !== rid || !readAt(r.at) ||
        !own(r.main, ['at','sha','checks']) || !readAt(r.main.at) || !revision(r.main.sha) ||
        !(list(r.prs, 0) || list(r.prs, 1) || (name === 'mojomast/orbitdesktop' && list(r.prs, 2)))) return false;
    // A local deployment observation carries revision identity only. It may not
    // smuggle in a check sample or PR state that was never read.
    if (r.prs.length === 0) {
      if (r.main.checks !== null) return false;
      continue;
    }
    if (!sha(r.main.sha) || !checks(r.main.checks, r.main.sha)) return false;
    for (const [j, p] of r.prs.entries()) {
      if (!own(p, ['at','number','head','base','state','draft','mergedAt','mergedSha','checks']) || p.number !== (j ? 48 : n) ||
          !readAt(p.at) || !sha(p.head) || !sha(p.base) || typeof p.draft !== 'boolean' ||
          !['open','closed','merged'].includes(p.state) || !checks(p.checks, p.head)) return false;
      if (p.state === 'merged') {
        if (p.draft || !sha(p.mergedSha) || !(instant(p.mergedAt) <= instant(p.at))) return false;
      } else if (p.mergedAt !== null || p.mergedSha !== null) return false;
    }
  }
  return true;
}

// Both dockets construct the URL from reviewed #92 paths or validated repo/SHA
// pairs. Never read a destination from a report. Comparing WindowProxy identity
// works in an opaque frame without accessing the parent's document or origin.
export function releaseCitation(doc, text, url) {
  const view = doc.defaultView;
  if (view && view.parent !== view) {
    const label = doc.createElement('label'), field = doc.createElement('input');
    const subject = text === 'Read the pinned decision ↗' ? 'Pinned decision' : text;
    label.textContent = `${subject} · Select URL to copy: `;
    field.type = 'text'; field.readOnly = true; field.size = 10; field.value = url;
    label.append(field);
    return label;
  }
  const a = doc.createElement('a');
  a.textContent = text; a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}

/** Replace only the current-state docket. Null/rejected data clears all prior public pins. */
export function renderReleaseObservation(root, value) {
  const node = (tag, text, cls) => {
    const el = root.ownerDocument.createElement(tag);
    if (text !== null && text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const article = node('article', null, 'release-docket');
  const header = node('header', null, 'docket-intro');
  header.append(node('small', 'CURRENT-STATE DOCKET  /  GITHUB REST API', 'docket-eyebrow'));
  article.append(header);
  if (!validateRelease(value)) {
    header.append(node('h2', 'Current release observation unavailable'),
      node('p', 'No validated release report is shared with this pane. The retained Workflow #92 decision is still available below.'));
    root.replaceChildren(article);
    return;
  }

  const {repos, startedAt, observedAt} = value;
  const observed = repos.filter(r => typeof r.main.sha === 'string').length;
  const unknown = repos.length - observed;
  const prs = repos.reduce((n, r) => n + r.prs.length, 0);
  const merged = repos.reduce((n, r) => n + r.prs.filter(p => p.state === 'merged').length, 0);
  header.append(node('h2', prs ? `${merged} of ${prs} component PRs merged at capture` : `${observed} of ${repos.length} loaded revisions observed`),
    node('p', `${Date.now() - instant(startedAt) > STALE_MS ? 'STALE at display · ' : ''}Non-atomic read: ${startedAt} to ${observedAt}. ` +
      `${observed} of ${repos.length} enrolled main refs observed${unknown ? `; ${unknown} revision${unknown === 1 ? '' : 's'} unknown` : ''}. ` +
      (prs ? `${repos[3].prs.length === 2 ? 'Hive #48 is shown separately.' : 'Optional Hive #48 was not collected.'}` :
        'No pull-request revisions were collected.')),
    node('p', prs ? 'Counts are sampled latest check runs on the displayed head. Required CI and combined-tree qualification are unknown. ' +
      'Refresh the source report before admission. The Workflow #92 decision applies to its retained tuple.' :
      'Only the revision identity of each local deployment checkout is shown; no check-run, PR, installed-artifact or loaded-parity evidence was collected. ' +
      'Refresh the source report before admission. The Workflow #92 decision applies to its retained tuple.'));

  function pins(repo, entries, dates) {
    const details = node('details', null, 'docket-pins'), dl = node('dl');
    details.append(node('summary', 'Exact commits & read times'));
    for (const [label, digest] of entries) {
      if (typeof digest !== 'string') continue;
      const dd = node('dd');
      dd.append(releaseCitation(root.ownerDocument, digest, `https://github.com/${repo}/commit/${digest}`));
      dl.append(node('dt', label), dd);
    }
    for (const [label, t] of dates) dl.append(node('dt', label), node('dd', t));
    details.append(dl);
    return details;
  }
  const table = node('table', null, 'docket-table'), thead = node('thead'), cols = node('tr'), tbody = node('tbody');
  table.append(node('caption', 'Observed repository revisions'));
  for (const title of ['Subject','Observed revision','Check-run evidence']) {
    const th = node('th', title); th.scope = 'col'; cols.append(th);
  }
  thead.append(cols);
  function row(repo, label, state, head, commits, checks, dates) {
    const tr = node('tr'), th = node('th', label), finding = node('td'), ci = node('td');
    th.scope = 'row';
    finding.append(node('strong', state), node('p', typeof head === 'string' ? head.slice(0,12) : 'Unknown'),
      pins(repo, commits, checks ? [...dates, ['Check runs read', checks.at]] : dates));
    if (checks) {
      ci.append(node('strong', `${checks.sampled}/${checks.total} sampled${checks.truncated ? ' · truncated' : ''}`));
      const counts = [['success','successful'],['failure','unsuccessful'],['pending','pending'],['skipped','skipped'],['neutral','neutral']];
      ci.append(node('p', counts.filter(([k]) => checks[k]).map(([k,label]) => `${checks[k]} ${label}`).join(' · ') || 'No runs in sample'));
    } else {
      ci.append(node('strong', 'No check-run evidence'), node('p', 'No CI sample was collected for this revision.'));
    }
    tr.append(th, finding, ci); tbody.append(tr);
  }
  for (const r of repos) {
    const name = r.repo.split('/')[1];
    row(r.repo, `${name} main`, typeof r.main.sha === 'string' ? 'Main head' : 'Revision unknown', r.main.sha,
      typeof r.main.sha === 'string' ? [['Main', r.main.sha]] : [], r.main.checks,
      [['Repository identity read',r.at],['Main ref read',r.main.at]]);
    for (const p of r.prs) {
      const commits = [['PR head (checked)',p.head],['PR base at read',p.base]];
      const dates = [['PR read',p.at]];
      if (p.state === 'merged') { commits.push(['Observed merge commit',p.mergedSha]); dates.push(['Merged',p.mergedAt]); }
      row(r.repo, `${name} #${p.number}${p.number === 48 ? ' · Hive' : ''}`, p.state === 'merged' ? 'Merged' :
        p.state === 'closed' ? 'Closed, unmerged' : p.draft ? 'Open draft' : 'Open, non-draft', p.head, commits, p.checks, dates);
    }
  }
  table.append(thead, tbody); article.append(table);
  const gaps = node('section');
  gaps.append(node('h3', 'Runtime parity · UNKNOWN'),
    node('p', 'Missing installed probe: a dated inventory binding all four installed artifact digests to their source commits.'),
    node('p', 'Missing loaded probe: the serving processes’ build IDs and the bytes loaded by the active Orbit pane, matched to that inventory.'),
    node('p', 'Missing deployment and rollback probes: a rollout receipt for the target service, a serving health check at that revision, and a restore rehearsal on the pinned prior artifacts.'));
  article.append(gaps);
  root.replaceChildren(article);
}
