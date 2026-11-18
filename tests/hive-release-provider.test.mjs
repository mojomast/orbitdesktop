import assert from 'node:assert/strict';
import test from 'node:test';
import {validateRelease, renderReleaseObservation} from '../apps/rizzstack-hive/release-provider.js';
import {renderRelease} from '../apps/rizzstack-hive/operations.js';

const A='a'.repeat(40), B='b'.repeat(40), C='c'.repeat(40);
const enroll=[['workflow',1455472841,91],['bundlebees',1454339884,82],['hyvv',1455851481,26],['orbitdesktop',1377703993,46]];
function report(elapsed=1000){
  const at=new Date(Date.now()-elapsed).toISOString();
  const checks=sha=>({at,sha,total:1,sampled:1,truncated:false,success:0,failure:0,neutral:0,pending:1,skipped:0});
  return {schema:'hive-release-read/1',startedAt:at,observedAt:at,repos:enroll.map(([name,repoId,number])=>({
    repo:`mojomast/${name}`,repoId,at,main:{at,sha:A,checks:checks(A)},
    prs:[{at,number,head:B,base:C,draft:false,state:'open',mergedSha:null,mergedAt:null,checks:checks(B)}]
  }))};
}
test('strict public projection binds every check sample, PR and merge receipt to its enrolled subject',()=>{
  assert.equal(validateRelease(report()),true);
  for(const mutate of [r=>r.repos.pop(), r=>r.repos.reverse(), r=>r.repos.push(r.repos[0]),
    r=>r.repos[0].repo='other/workflow', r=>r.repos[0].repoId++, r=>r.repos[0].prs[0].number=92,
    r=>r.repos[0].prs[0].mergedSha=A, r=>r.repos[0].prs[0].state='merged',
    r=>r.repos[0].prs[0].checks.sha=A, r=>r.repos[0].main.sha='HEAD',r=>r.repos[0].prs[0].base='0'.repeat(40),
    r=>r.repos[0].prs[0].head+='\n', r=>r.repos[0].prs[0].draft=0,
    r=>r.repos[0].main.checks.sampled=51, r=>r.repos[0].main.checks.truncated=true,
    r=>r.repos[0].main.checks.total=2, r=>r.repos[0].main.checks.success=-1,
    r=>r.repos[0].main.checks.neutral=0.5, r=>r.repos[0].main.checks.success=1,
    r=>r.repos[0].main.checks.url='https://untrusted.invalid',r=>r.authority='PROMOTE']){
    const r=report(); mutate(r); assert.equal(validateRelease(r),false,mutate.toString());
  }
  for(const junk of [null, [], {}, 1, '']) assert.equal(validateRelease(junk),false);
  const r=report(), pr=r.repos[3].prs[0]; r.repos[3].prs.push({...pr,number:48});
  Object.assign(pr,{state:'merged',mergedSha:C,mergedAt:pr.at});
  Object.assign(pr.checks,{total:17,truncated:true}); assert.equal(validateRelease(r),true);
});
test('non-atomic read times must be real UTC instants ordered within one bounded capture',()=>{
  for(const mutate of [r=>r.observedAt='2025-02-30T00:00:00.000Z', r=>r.startedAt='yesterday',
    r=>r.repos[0].at='2020-01-01T00:00:00.000Z',r=>r.startedAt='2001-01-01T00:00:00.000Z',
    r=>r.repos[0].prs[0].at=new Date(Date.parse(r.observedAt)+1).toISOString(),
    r=>{r.startedAt=new Date(Date.parse(r.observedAt)-1000).toISOString();r.repos[0].main.checks.at=r.startedAt;},
    r=>{Object.assign(r.repos[0].prs[0],{state:'merged',mergedSha:A,mergedAt:'2200-01-01T00:00:00.000Z'});}]){
    const r=report(); mutate(r); assert.equal(validateRelease(r),false,mutate.toString());
  }
  assert.equal(validateRelease(report(-3600000)),false);
  assert.equal(validateRelease(report(86400000)),true,'old evidence remains valid dated evidence');
});

function dom(embedded=false){
  const view={}; view.parent=embedded?{}:view;
  const doc={defaultView:view,createElement(tag){return {ownerDocument:doc,tag,children:[],textContent:'',
    append(...els){this.children.push(...els);},replaceChildren(...els){this.children=els;}};}};
  const root=doc.createElement('section'), walk=n=>[n,...n.children.flatMap(walk)];
  return {root,text:()=>walk(root).map(el=>el.textContent).join(' '),all:()=>walk(root)};
}
test('current docket is replaceable dated evidence, never a required-check verdict or runtime authority',()=>{
  const d=dom(), r=report(86400000); renderReleaseObservation(d.root,r);
  for(const re of [/stale/i,/non.atomic/i,/workflow #91/i,/sampled/i,/required CI/i,/UNKNOWN/,/installed/i,/loaded/i,/deployment/i,/rollback/i]) assert.match(d.text(),re);
  for(const a of d.all().filter(n=>n.tag==='a')){
    assert.match(a.href,/^https:\/\/github\.com\/mojomast\/(workflow|bundlebees|hyvv|orbitdesktop)\/commit\/[a-f0-9]{40}$/);
    assert.equal(a.rel,'noopener noreferrer');
  }
  const newer=report(); const p=newer.repos[0].prs[0]; Object.assign(p,{state:'merged',mergedSha:C,mergedAt:p.at});
  renderReleaseObservation(d.root,newer); assert.match(d.text(),/merged/i); assert.ok(d.text().includes(newer.observedAt));
  assert.ok(!d.text().includes(r.observedAt));
  for(const value of [null,{secret:'SHOULD_NOT_RENDER'}]){
    renderReleaseObservation(d.root,value); assert.match(d.text(),/unavailable/i); assert.ok(!d.text().includes(A));
    assert.ok(!d.text().includes('SHOULD_NOT_RENDER'));
  }
});

test('enrolled and historical citations preserve exact standalone destinations as selectable source addresses in a pane',()=>{
  for(const render of [root=>renderReleaseObservation(root,report()),renderRelease]){
    const standalone=dom(), pane=dom(true);
    render(standalone.root); render(pane.root);
    const links=standalone.all().filter(n=>n.tag==='a');
    assert.ok(links.length>0);
    for(const a of links){
      assert.equal(a.target,'_blank'); assert.equal(a.rel,'noopener noreferrer');
      assert.match(a.href,/^https:\/\/github\.com\/mojomast\/(?:(?:workflow|bundlebees|hyvv|orbitdesktop)\/commit\/[a-f0-9]{40}|workflow\/blob\/2d45b5958abed555b910cbddd5bdfe5e8b22144d\/evidence\/rails-rc\/[\w./-]+)$/);
    }
    assert.equal(pane.all().filter(n=>n.tag==='a').length,0,'a scripts-only frame cannot open popup links');
    const fields=pane.all().filter(n=>n.tag==='input' && n.readOnly && !n.disabled);
    assert.deepEqual(fields.map(f=>f.value),links.map(a=>a.href));
    assert.match(pane.text(),/select.*URL.*copy/i);
    assert.equal(pane.all().filter(n=>n.tag==='button').length,0);
  }
});
