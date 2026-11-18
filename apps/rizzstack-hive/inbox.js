// Input is the host's public projection. Never inspect raw collector errors,
// objectives or free-form evidence in order to infer cause or severity.
const sourceKinds = new Map(Object.entries({job:'pipeline',task:'pipeline',backlog:'backlog',ci:'ci',failure:'failures',bottleneck:'bottlenecks',decision:'decisions'}));
export function evidenceFor(view, signal) {
  // An explicit pointer is authoritative even when broken: do not silently
  // substitute the attention ID, a similarly named row, or another source.
  const id = signal.detail ?? signal.id;
  const found = view.records.filter(r => r.id === id);
  if (found.length !== 1) return null;
  const r = found[0];
  if (r.kind==='decision' && r.id!==signal.id) return null;
  return sourceKinds.has(r.kind) && r.source === signal.source && r.source === `snapshot/1:${sourceKinds.get(r.kind)}` ? r : null;
}

const unknown = 'Unknown. No later recovery receipt is linked.';
const classified = (category, shortCategory, impact, cause, severity, next, recovery=unknown) =>
  ({category,shortCategory,impact,cause,severity,next,recovery});

function diagnosis(v, a, record, section, historical) {
  if (historical || /^last observed:/i.test(record?.state)) return classified('Last observed','History',
    'Current impact is unconfirmed.', 'This observation is historical.', 'Unknown',
    'Compare a fresh read of this source before investigating the earlier signal.');
  if (a.id === 'section:fleet-count' && section?.id === 'fleet') return classified('Source integrity','Tally',
    'The in-flight total cannot be confirmed.', 'The fleet tally and supporting rows do not reconcile.', 'Data conflict',
    'Compare the collection time, attempt rows and in-flight count in one fresh fleet read.');
  if (!record && section && a.id === `section:${section.id}` && section.state !== 'live') return classified('Source integrity','Source',
    `Current ${section.id} facts are unknown.`, `The section reports ${section.state}. The underlying cause is unknown.`, 'Coverage gap',
    'Check when the collector last read this section successfully.');
  if (record?.kind === 'decision' && a.id === record.id && record.state === 'pending' && section?.state === 'live') {
    const subject = v.records.filter(r=>record.jobId && r.kind==='job' && r.jobId===record.jobId && r.id===`job:${record.jobId}` &&
      r.source==='snapshot/1:pipeline' && !/^last observed:/i.test(r.state));
    const name = subject.length===1 && v.sections.some(s=>s.id==='pipeline' && s.state==='live') && subject[0].title;
    return classified('Owner decision','Owner',name ? `Owner input requested for ${name}.` : 'The queue reports a pending owner question.',
      'Pending in the decision queue. Any effect on downstream work is unknown.', 'Owner input requested',
      'Compare this exact request with the sealed preview in the owner’s system.', 'Unknown. No effect receipt is linked.');
  }
  if (section?.state === 'live') {
    if (record?.kind === 'bottleneck' && record.id === 'bottleneck:invariant') return classified('Pipeline pressure','Capacity',
      'Eligible work was waiting despite reported capacity.', 'The scheduler invariant reports a mismatch. The blocking dependency is unknown.', 'Delay signal',
      'Compare the eligible queue, active claims and available slots from the same scheduler read.');
    if (record?.kind === 'bottleneck' && record.state === 'over') {
      const s=v.stations?.find(s=>s.id===record.stage && ['known','partial'].includes(s.quality));
      return classified(record.stage === 'verify' ? 'Verification queue' : 'Pipeline pressure','Dwell',
        Number.isSafeInteger(s?.depth) ? `Dwell over target; ${s.depth} in the observed queue.` : 'Queue dwell exceeded its measured target.',
        'The stage timing crossed the configured threshold. The cause of the wait is unknown.', 'Delay signal',
        'Compare the oldest queue entry with the measured dwell, target and throughput.');
    }
    if (record?.kind === 'failure') return classified('Failure record','Failure',
      record.stage === 'verify' ? 'The verifier recorded a failure.' : 'The failure source recorded an incident.',
      `Reported class: ${record.state}. A class does not establish root cause.`, 'Failure observed',
      'Inspect the matching attempt, failure code and later verifier evidence for the same contract and revision.');
    if (record?.kind === 'ci' && a.id === 'section:failing-ci') return classified('Check failure','Check',
      'CI reported failing checks on this PR.', 'The CI source reports failure. The failing revision and review disposition are unknown.', 'Failure observed',
      'Read the checks for the current PR head; compare their run and suite IDs.');
    if (record?.kind === 'job' && a.id === 'section:failed-tasks') return classified('Failed task','Task',
      'A pipeline task was reported failed.', 'The task state is reported by the pipeline; a job-wide failure is not established.', 'Failure observed',
      'Compare the failed task with its attempt history and any exact verifier record.');
    if (record?.kind === 'backlog' && record.state === 'failed') return classified('Failed feature','Feature',
      'The backlog reports a failed feature.', 'The backlog state does not identify the failed attempt or root cause.', 'Failure observed',
      'Inspect the feature’s claim and the return for its exact job.');
    if (section.id === 'alerts' && a.id.startsWith('alert:')) return classified('Threshold warning','Alert',
      'A configured threshold raised a warning.', 'The alert key identifies a threshold, not the underlying incident.', 'Threshold warning',
      'Compare the named threshold with its current measurement and observation time.');
  }
  return classified('Investigate','Signal','Impact unknown.', 'No uniquely linked source finding establishes a cause.', 'Unknown',
    'Inspect the source and its observation time before drawing a conclusion.');
}

// A failure can remain in the evidence register long after it drops out of
// attention. Inspecting that observation must not reopen an incident. Likewise
// PR/open and feature/ready_for_review are never actual reviewer assignments.
export function recordFinding(v, row, historical = false) {
  if (!row || !['failure','ci','backlog'].includes(row.kind) || row.source!==`snapshot/1:${sourceKinds.get(row.kind)}`) return null;
  const s=v.sections.find(s=>row.source===`snapshot/1:${s.id}`);
  let finding;
  if (historical || s?.state!=='live' || /^last observed:/i.test(row.state)) {
    finding=diagnosis(v,{},row,s,true);
  } else if (row.kind==='failure') {
    finding=diagnosis(v,{},row,s,false);
  } else if (row.kind==='ci') {
    finding=classified('Pull request','PR','The PR was observed; review disposition is unknown.',
      'A CI observation does not establish review or integration on the current head.', 'Observation',
      'Compare the current PR head with the exact check run and any independent review.', 'Unknown. No effect receipt is linked.');
  } else if (row.state==='ready_for_review') {
    finding=classified('Queue state','Queue','The backlog marked this feature ready for review.',
      'No reviewer assignment, independent verdict or reviewed revision is supplied.', 'Queue observation',
      'Inspect the candidate head and look for a review bound to that revision.');
  }
  return finding ? {...finding,signalClass:row.kind==='failure' && finding.shortCategory==='Failure' ? row.state : finding.category} : null;
}

export function inboxItems(v, historical = false) {
  const rows = [], common = new Map();
  for (const a of v.attention) {
    const record = evidenceFor(v,a);
    const section = v.sections.find(s => a.source === `snapshot/1:${s.id}`);
    const finding = diagnosis(v,a,record,section,historical);
    const owner = finding.shortCategory === 'Owner';
    const ageMs = Date.parse(v.generatedAt) - Date.parse(a.at);
    const age = !Number.isFinite(ageMs) || ageMs < 0 ? null : ageMs < 60_000 ? 'at snapshot' :
      ageMs < 3_600_000 ? `${Math.floor(ageMs/60_000)}m before snapshot` : `${Math.floor(ageMs/3_600_000)}h before snapshot`;
    // Only coalesce aliases of one measured pressure crossing. A stage, job,
    // failure class, alert key or timestamp alone never proves common cause.
    // Section summaries may only name an example; never group by that example.
    const same = record?.kind === 'bottleneck' && finding.shortCategory === 'Dwell' &&
      a.stage === record.stage && a.at === record.at ? record.id : null;
    if (same && common.has(same)) { common.get(same).signalCount++; continue; }
    const row = {...finding,id:a.id,owner,rank:finding.shortCategory === 'Tally' ? 0 : owner ? 1 : record?.kind === 'bottleneck' ? 2 : 3,
      title:record?.kind === 'decision' ? record.title : a.title, note: a.reason || finding.impact, age, stage:a.stage,
      level:finding.shortCategory === 'History' ? 'unknown' : a.level, signalCount:1,
      signalClass:record?.kind==='failure' && finding.shortCategory==='Failure' ? record.state : finding.category,
      target:{kind:record?.kind ?? 'attention', id:record?.id ?? a.id}};
    rows.push(row);
    if (same) common.set(same,row);
  }
  return rows.sort((a,b)=>a.rank-b.rank);
}

export function emptyInbox(v) {
  if (!v.generatedAt) return 'Awaiting a source. Owner requests, pressure and failures are unknown.';
  const missing = ['decisions','bottlenecks','failures','alerts','ci','backlog','pipeline','fleet'].filter(
    id => !v.sections.some(x=>x.id===id && x.state==='live'));
  if (!missing.includes('decisions') && !v.stations?.some(s=>s.id==='receiver' && s.quality==='live' && s.depth===0)) missing.push('current owner requests');
  return missing.length ? `No signals in this observation. Incomplete coverage: ${missing.join(', ')}.` :
    'No active attention signals reported by the covered sources.';
}
