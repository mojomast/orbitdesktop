// Called only by the offline integration harness. No raw snapshot/catalog is
// transmitted to the pane. The second alias belongs to an actual, but absent,
// row in the earlier reviewed publication, not an unvalidated catalog entry.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {applyLabels,projectLabelView,publishLabels,validateLabels} from '../apps/rizzstack-hive/public-labels.js';
import {validateQueue} from '../apps/rizzstack-hive/queue-provider.js';
import {validateRelease} from '../apps/rizzstack-hive/release-provider.js';

const dir=process.argv[2], snapshot=JSON.parse(fs.readFileSync(0,'utf8'));
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const queue=read('queue.json'),release=read('release.json');
assert.equal(validateQueue(queue),true);assert.equal(validateRelease(release),true);
assert.equal(queue.coverage.state,'PARTIAL');assert.equal(queue.lease.state,'recorded');
assert.ok(release.repos.at(-1).prs.some(p=>p.number===48));

const reviewed=structuredClone(snapshot),jobs=reviewed.pipeline.jobs;
const earlier={...structuredClone(jobs[0]),job_id:'earlier-docket'};
jobs.push(earlier);
const alias='Prism relay',outside='Copper relay';
const rows=[jobs[0],earlier].map((r,i)=>({kind:'job',repo:r.repo,id:r.job_id,jobId:r.job_id,title:i?outside:alias}));
const sha=createHash('sha256').update(JSON.stringify(reviewed)).digest('hex');
const labels=await publishLabels(reviewed,{version:'hive.public-aliases/1',snapshotSha256:sha,rows},sha);
assert.equal(validateLabels(labels),true);
const projected=applyLabels(await projectLabelView(snapshot),labels);
assert.equal(projected.records.find(r=>r.id==='job:job-fixture')?.title,alias);
assert.ok(!JSON.stringify(projected).includes(outside));
fs.writeFileSync(path.join(dir,'labels.json'),JSON.stringify(labels),{flag:'wx',mode:0o600});
console.log(JSON.stringify({alias,outside,feature:queue.subject.featureId,releaseAt:release.observedAt,queueDigest:queue.queue.sha256}));
