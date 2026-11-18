import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateQueue, renderQueueDocket} from '../apps/rizzstack-hive/queue-provider.js';

const hash = 'a'.repeat(64);
const doc = () => ({version:'hive.queue/1', subject:{featureId:'F1',jobId:'job_a'},
  observedAt:new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  queue:{state:'claimed',updatedAt:null,sha256:hash},
  scheduler:{state:'pending',overlap:'recorded',sha256:hash}, lease:{state:'recorded',sha256:hash},
  coverage:{state:'PARTIAL',head:'b'.repeat(40),covered:2,total:3,sha256:hash,verificationSha256:hash}});

test('only coherent, strictly projected JSON is accepted', () => {
  assert.equal(validateQueue(doc()),true);
  for (const mutate of [d=>{d.label='private'},d=>{d.queue.url='https://example.org'},d=>{d.scheduler.owner='key'},
    d=>{d.subject.jobId+='\n'},d=>{d.observedAt='2026-02-31T00:00:00Z'},d=>{d.observedAt='9999-01-01T00:00:00Z'},
    d=>{d.coverage.covered=true},d=>{d.coverage.total=2},d=>{d.coverage.state='LANDED'},
    d=>{d.lease={state:'unknown',sha256:null}},d=>{d.coverage.verificationSha256=null},
    d=>{d.coverage.head='1234567'},d=>{d.scheduler.state='unknown'}, d=>{d.subject.featureId='x'.repeat(70000)}]) {
    const value=doc(); mutate(value); assert.equal(validateQueue(value),false);
  }
  assert.equal(validateQueue(null),false);
});

class Element {
  children=[]; textContent=''; ownerDocument={createElement:()=>new Element()};
  append(...els){this.children.push(...els)} replaceChildren(...els){this.children=els}
  get text(){return [this.textContent,...this.children.map(el=>el.text)].join(' ')}
}
for (const [state, wording] of [
  ['PARTIAL', /draft.*some.*leased files/i],
  ['COVERED_BY_DRAFT', /draft.*all.*leased files/i],
  ['LANDED', /merged.*all.*leased files/i],
]) {
  test(`${state} explains file coverage and the timestamp's source`, () => {
    const value = doc(), root = new Element();
    value.coverage.state = state;
    if (state !== 'PARTIAL') value.coverage.covered = value.coverage.total;
    renderQueueDocket(root, value);
    assert.match(root.text, wording);
    assert.match(root.text, /acceptance criteria (?:were )?not evaluated/i);
    assert.match(root.text, /local record read/i);
    assert.doesNotMatch(root.text, /covers (?:part of )?the job scope/i);
  });
}
test('historical evidence labelled, invalid or cleared grant discards it',()=>{
  const value=doc(), root=new Element(); value.observedAt='2020-01-01T00:00:00Z';
  renderQueueDocket(root,value);
  assert.match(root.text,/stale/i); assert.match(root.text,/PARTIAL/); assert.match(root.text,/2 of 3/);
  assert.match(root.text,/job_a/); assert.match(root.text,/dispatch/i);
  renderQueueDocket(root,{...value,raw:'private data'});
  assert.match(root.text,/unavailable/i); assert.doesNotMatch(root.text,/job_a|PARTIAL|private data/);
  renderQueueDocket(root,null); assert.match(root.text,/unavailable/i);
});
