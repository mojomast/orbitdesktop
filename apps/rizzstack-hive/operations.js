import { release } from './release.js';
import { releaseCitation } from './release-provider.js';

// Refusals, not executable actions. These facts belong to the source owner,
// regardless of the pane's connection, a role label, or caller-supplied keys.
const refusals = {
  retry: ['Retry attempt', 'RetryHandoff is coordinator-local; Hive has no retry executor.', 'Check the attempt, contract, remaining budget and current lease fence with the coordinator.'],
  verify: ['Rerun verification', 'No verifier is registered for requests from this pane.', 'Ask the verifier for a run bound to the candidate SHA, frozen contract and suite.'],
  dispatch: ['Dispatch work', 'A queue observation or overlap suggestion grants no dispatch lease.', 'Have the coordinator reconcile dependencies, budget, assignment and overlapping file scopes.'],
  pause_dispatch: ['Pause dispatch', 'No scheduler maintenance provider is enrolled.', 'Agree a maintenance window with the scheduler owner and account for active leases.'],
  resume_dispatch: ['Resume dispatch', 'Hive cannot clear a scheduler hold.', 'Have the scheduler owner check the hold, capacity and current claims.'],
  change_route: ['Change route or budget', 'The overview projects route and usage; it cannot edit worker configuration.', 'Review the scoped configuration change and spending ceiling with the routing owner.'],
  register_worker: ['Register worker', 'Worker presence does not grant enrollment or assignment.', 'Verify the worker and ledger identity through the host operator.'],
  reconcile: ['Apply queue suggestion', 'Draft coverage is advisory; there is no queue writer here.', 'Compare the frozen criteria, current PR head and claim in the coordinator.'],
  quality_feedback: ['Sign quality feedback', 'Any enrolled quality signer belongs to the trusted Rails shell.', 'Inspect the exact origin event in Rails; a quality note cannot approve work.'],
  decision: ['Submit owner decision', 'Hive has no provider for this decision queue. The Hermes trial-job approval card has a different scope.', 'Ask the owner to compare the sealed request, permitted responses and intended effect in the originating system.'],
  merge: ['Merge or integrate', 'Hive has no merge provider. A component check is not independent review.', 'Verify the base and head, file lease, independent review and combined-tree tests.'],
  deploy: ['Deploy release', 'There is no scoped deployment authority in this pane.', 'Requalify the intended tuple and obtain a dated rollout and recovery grant.'],
  rollback: ['Roll back release', 'No pinned rollback target or authorized rollback provider is attached.', 'Rehearse restoration of the retained prior artifacts on protected copies.'],
  promote: ['Promote release', 'The packet records HOLD; the pane has no promotion provider.', 'Close the canary and parity gates and obtain a separate human decision.'],
};
const byStage = {
  auth: ['decision', 'dispatch'], dispatch: ['dispatch', 'pause_dispatch', 'resume_dispatch', 'register_worker'],
  build: ['retry', 'verify', 'change_route'], verify: ['verify', 'retry'], review: ['quality_feedback', 'merge'],
  integrate: ['merge', 'verify'], deploy: ['deploy', 'rollback', 'promote'], receiver: ['decision', 'quality_feedback'],
};
const safeID = id => typeof id === 'string' && id.toLowerCase() !== 'unknown' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id);
function selectedTarget(selection, record) {
  if (!selection || !record || !safeID(selection.id) || selection.id !== record.id ||
    (record.quality && record.quality !== 'live') || /^last observed:/i.test(record.state)) return null;
  if (selection.kind === 'attempt' && (!record.kind || record.kind === 'attempt') && safeID(record.id)) {
    return {kind: 'attempt', id: record.id};
  }
  if (selection.kind === record.kind && ['job', 'task', 'backlog', 'failure'].includes(record.kind) && safeID(record.jobId)) {
    return {kind: 'job', id: record.jobId};
  }
  return null;
}

// `providers` is supplied only by the controller. `rails` is the session's
// connectHost handle. The descriptor advertises navigation, never a successful
// history read. The trusted host checks the grant, latest selector set and age
// again, and the shell requires a second deliberate Inspect action.
export function controlsFor({selection, record, mode, status, connected, providers} = {}) {
  const stage = selection?.kind === 'station' ? selection.id : record?.stage;
  const intents = selection?.kind === 'backlog' ? ['reconcile', 'dispatch'] :
    byStage[Object.hasOwn(byStage, stage) ? stage : 'build'];
  const controls = intents.map(id => {
    const [label, reason, next] = refusals[id];
    return {id, kind: 'write', label, available: false, reason, next};
  });
  const target = selectedTarget(selection, record);
  if (target) {
    const hostMode = mode === 'host';
    const available = hostMode && connected === true && (!status || status === 'connected') && !!providers && Object.hasOwn(providers, 'rails') &&
      typeof providers.rails?.openRails === 'function';
    controls.unshift({id: 'open_rails', kind: 'navigation', label: 'Open Rails timeline', available, target,
      reason: available ? 'The host can open its reader on this exact public selector.' :
        hostMode ? 'No connected, granted Rails navigation provider.' : 'Fixture IDs do not authorize a live lookup.',
      next: available ? 'Choose Inspect history in Orbit to read the selected scope.' : 'Share the host overview, then select an observed attempt or job.'});
  }
  return controls;
}

// /1 is a queue observation, not the sealed request/decision documents. Keep
// these questions separate: a queue marker is evidence of neither consent nor
// its execution. A job base, a PR in the same repo and a release tuple cannot
// supply the *current subject-bound* contract or candidate head. Never carry
// an old head forward across refreshes, nor adopt arbitrary extra row keys.
export function decisionReadiness(view, row, historical = false) {
  if (!row || row.kind !== 'decision' || row.source !== 'snapshot/1:decisions' ||
    view.records.filter(r=>r.id===row.id).length !== 1 || !view.records.includes(row)) return null;
  const current = !historical && view.sections.some(s=>s.id==='decisions' && s.state==='live') && !/^last observed:/i.test(row.state);
  const job = safeID(row.jobId) ? row.jobId : null;
  const report = ['pending','decided','applied','withdrawn','reported applied (time unknown)'].includes(row.state) ? row.state : 'unknown';
  // Only exact public display subjects already admitted by the adapter. Do
  // not render opaque subjects or treat any generic subject string as a job.
  const publicSubjects = ['observability bridge','snapshot adapter','release candidate','receipt replay','integration results','deployment rollback','worker routing','verification evidence','Rails timeline'];
  const subject = publicSubjects.find(s=>row.detail?.startsWith(`Subject: ${s}. Queue reports `));
  return {current, report:current ? `Queue reports ${report}` : 'Last observation · current state unknown',
    rows:[['Subject',job ? `Job ${job}` : subject],['Bound job',job],
      ['Current contract',null],['Current candidate head',null],['Permitted options',null],['Current lease',null],
      ['Remaining budget',null],['Owner authority',null],['Effect receipt',null]],
    next: current ? 'Compare the sealed request and its digest with the current contract and head in the originating system. Look for a separate receipt for any reported effect.' :
      'Obtain a fresh queue observation before comparing the sealed request with its subject.'};
}

// A distinct, point-in-time CLI observation; NEVER update release.tuple from
// this list. SHA-specific latest check-runs, not a required-check verdict.
// Capture procedure/window and provenance are in docs/HIVE_OPERATIONS.md.
const gitWindow = '2026-11-18 00:19:02–00:19:05 UTC';
const gitCapture = [
  {repo: 'workflow', pr: 91, prHead: 'badc5591d7e5d4985fe829c3a1e39b2ee0e4c0f6', prChecks: '14 successful', main: '58aa9690c2494ab0ffc37094a6c303ac09cd7510', mainChecks: '14 successful'},
  {repo: 'bundlebees', pr: 82, prHead: '433dfa1f6ae7ada071d3ccfb0056b8a0e13b2aa0', prChecks: '0 reported', main: '4ed25529cc18e32e5c0161bc538aae086ae5eb89', mainChecks: '3 successful, 1 in progress'},
  {repo: 'hyvv', pr: 26, prHead: '35a4d0cf9473b3d30a2b8eb0b71ab9d10b6509a8', prChecks: '14 successful', main: '9bed64999f23d12c354c6f714b70e182f54f4486', mainChecks: '14 successful'},
  {repo: 'orbitdesktop', pr: 46, prHead: '43a3cb61b8e5f9822c3bcc1431afe850b8ca0c3e', prChecks: '32 successful', main: '9cb894b76df30b6852e7d899a3b5e82fc97eb5ee', mainChecks: '10 successful, 1 skipped'},
];
const packet = 'Workflow #92 · retained';
const github = `GitHub CLI · ${gitWindow}`;
const decision = 'DECISION.md';
const replay = 'offline-replay.json';
const native = 'campaign/jobs/r18-coding/return.json';
const sidecar = 'campaign/jobs/r18-coding/rails-evidence.json';
const missing = 'No runtime receipt';

// Each gate has its own finding, basis, currentness and next decision. Artifact
// paths below are reviewed literals relative to the pinned DECISION.md only.
const gates = [
  ['01', 'Revision ledger', [
    ['Qualified candidate tuple', 'Four draft heads', 'Workflow #91, BundleBees #82, Hyvv #26 and Orbit #46 were tested together.', '../release.json', packet, 'Compare all four SHA pins before using the qualification.', 'candidate'],
    ['Required software cases', `${release.tests} passed`, 'Zero required skips, failures or errors in the cross-stack gate.', 'summary.json', packet, 'Repeat the four-checkout suite on any changed tuple.'],
    ['Component CI', `${release.checks} successful checks`, 'Reported check jobs on those four exact PR heads; these are not test cases.', 'ci.json', `Historical CI · ${release.at}`, 'Read the check results for the proposed heads.'],
    ['PR heads & merge state', 'Open at capture', 'All four PRs were open and unmerged. BundleBees #82 no longer matched its qualified head.', null, github, 'Re-read the PR head, merge status and SHA-specific checks before review.', 'prHead'],
    ['Current main', 'Dated capture only', 'Four main refs and their reported check runs were read separately. Current main is not live in this pane.', null, github, 'Read the four refs again at admission; qualify the intended combination.', 'main'],
    ['Current-head qualification', 'Not established', 'No new cross-stack result was supplied for the captured PR tuple or main tuple. The 64 historical jobs do not carry over.', null, github, 'Retain a new required-case and CI packet at the exact candidate tuple.'],
    ['Independent release review', release.decision, 'The reviewer retained the software evidence and withheld promotion.', decision, packet, 'Resolve the named gaps and seek review of the exact revised packet.'],
  ]],
  ['02', 'RETURN & integration', [
    ['Native RETURN', 'Digest linked', 'SHA-256 6058fa382132dfb728908e47ddb519fc15a3d9241a21bd083b717482a9e3c585', native, packet, 'Verify the original bytes against the retained digest.'],
    ['Rails evidence sidecar', 'Linked by the RETURN', 'SHA-256 0701a07bdd50103627d57871e541b7625cd89ebd8ec2f15d9c8888c7e34754cf', sidecar, packet, 'Resolve the digest in the native acceptance evidence before review.'],
    ['Independent receiver replay', 'Reproduced offline', 'RED at 56276756d3296342b71dd814872bb7a899c107e9; verified GREEN at cad02b6b123f7397e5ef179fc8b6c2d822b7e2df.', replay, 'Historical · fixture/r18', 'Retain the verifier, contract and candidate pins for the receiver.'],
    ['Integration head', 'Combined tree passed', 'fixture/r18 wave r18-coding.w1: integrated GREEN at f2c1f30980d7c001a2402aa316f20f03b0a3e08b. This is the fixture tree, not a GitHub merge SHA.', replay, 'Historical · fixture/r18', 'Verify a real integrated revision with its own wave and suite.'],
    ['Human receiver', release.receiver, 'No decision by a named human receiver in the native handoff.', native, packet, 'Present the bound evidence to the receiver and retain their separate decision.'],
  ]],
  ['03', 'Operational gates', [
    ['Native Windows CI', 'Passed on runner', 'Hosted native tests passed; a CI runner is not the assigned Windows worker.', decision, packet, 'Keep the runner result separate from a live dispatch receipt.'],
    ['Live Windows canary', 'Blocked · not run', 'No live canary receipt. Pre-dispatch attribution and operator authorization were missing.', decision, packet, 'Obtain a dated worker and workspace grant, capacity window and interruption/recovery authority.'],
    ['Worker attribution', 'Unproven', 'An observed worker chain does not prove assignment before dispatch.', '../dispatch-prerequisite.md', packet, 'Bind endpoint, worker/ledger, job, project, contract and revision before dispatch; reconcile the returned attempt.'],
    ['Authenticated HTTP p95', 'Unqualified', `100,000 events; 500 ms target. Default events ${release.defaultEventsMs} ms, view 525.956 ms. Indexed events ${release.indexedEventsMs} ms, view 189.422 ms; earlier indexed events ${release.priorIndexedEventsMs} ms.`, 'evaluation.json', packet, 'Repeat both surfaces on the intended hardware, index configuration and mixed origins.'],
    ['Stream & memory', 'Memory unqualified', 'Local 30-minute soak: connected viewport p95 1,390.622 ms; reconnect p95 1,684.463 ms. Node RSS and Chromium PSS grew.', 'soak.json', packet, 'Repeat a longer soak with a fixed-history control.'],
    ['Historical-state compatibility', 'Unverified', 'One copied synthetic wave passed; no historical production copy was supplied.', 'copied-synthetic-wave.json', packet, 'Run compatibility preflight on a protected historical copy.'],
    ['Installed revisions', 'Unknown', 'No host inventory attests to the installed component SHAs.', decision, missing, 'Have the operator inspect the installed tuple and artifact digests.'],
    ['Loaded revisions', release.loaded, 'No process or pane receipt matches running bytes to the installed tuple.', decision, missing, 'Compare separately observed loaded bytes with the installed artifacts.'],
    ['Deployment & live parity', 'Unverified', 'Neither main refs nor a matching install manifest proves the release is serving.', decision, missing, 'Reconcile the staged live receipt with the qualified tuple and loaded bytes.'],
    ['Rollback readiness', 'Unrehearsed', 'A documented reverse sequence is not an observed restoration.', '../coordination.md', missing, 'Rehearse restore to a retained prior tuple and verify loaded parity after restoration.'],
    ['Owner promotion', 'Withheld', 'Reviewer HOLD, missing canary and pending receiver leave no authority to promote.', decision, packet, 'Obtain the operations owner’s promotion decision after the open gates close.'],
  ]],
];

export function renderRelease(root) {
  const doc = root.ownerDocument;
  const node = (tag, text, cls) => {
    const n = doc.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const link = (text, url) => releaseCitation(doc, text, url);
  const pins = field => {
    const details = node('details', null, 'docket-pins');
    details.append(node('summary', field === 'candidate' ? 'Qualified SHA pins' : 'Captured SHA pins & checks'));
    const dl = node('dl');
    for (const row of gitCapture) {
      const sha = field === 'candidate' ? release.tuple[row.repo] : row[field];
      const value = node('dd');
      value.append(link(sha, `https://github.com/mojomast/${row.repo}/commit/${sha}`));
      if (field !== 'candidate') value.append(node('span', field === 'main' ? row.mainChecks : row.prChecks));
      dl.append(node('dt', field === 'main' ? `${row.repo} main` : `${row.repo} #${row.pr}`), value);
    }
    details.append(dl);
    return details;
  };
  const docket = node('article', null, 'release-docket');
  const intro = node('header', null, 'docket-intro');
  intro.append(node('small', 'RELEASE RECORD  /  WORKFLOW #92', 'docket-eyebrow'),
    node('h2', `Software qualified · release ${release.decision}`),
    node('p', 'The four Rails draft heads passed the software gate. The reviewer withheld release: the live Windows canary did not run, and no human receiver decision was recorded.'),
    link('Read the pinned decision ↗', release.evidenceUrl));
  docket.append(intro);
  for (const [index, title, entries] of gates) {
    const table = node('table', null, 'docket-table');
    const caption = node('caption');
    caption.append(node('small', index), node('span', title));
    const thead = node('thead'), cols = node('tr');
    for (const label of ['Gate', 'Finding', 'Evidence / currentness', 'Next gate']) {
      const th = node('th', label); th.scope = 'col'; cols.append(th);
    }
    thead.append(cols);
    const body = node('tbody');
    for (const [gate, status, finding, file, currentness, next, ref] of entries) {
      const tr = node('tr'), name = node('th', gate), observed = node('td'), source = node('td');
      name.scope = 'row';
      observed.append(node('strong', status), node('p', finding));
      if (ref) observed.append(pins(ref));
      if (file) source.append(link(file.split('/').at(-1), new URL(file, release.evidenceUrl).href));
      source.append(node('span', currentness));
      tr.append(name, observed, source, node('td', next));
      body.append(tr);
    }
    table.append(caption, thead, body);
    docket.append(table);
  }
  root.replaceChildren(docket);
}
