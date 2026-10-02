import test from 'node:test';
import assert from 'node:assert/strict';
import {traceDiagnosticSummary} from '../src/run-trace-summary.ts';

test('diagnostics distinguish open, local and overlapping observed spans without copying private attributes',()=>{
  const trace={trace_id:'a'.repeat(32),method:'normal',run_id:'run-1',status:'running',partial:true,updated_at:1700000001000,session_id:'SECRET_SESSION'};
  const base={version:1,trace_id:trace.trace_id,span_id:'b'.repeat(16),parent_span_id:null,name:'SECRET_TOOL',start_unix_ms:100,end_unix_ms:400,status:'ok',duration_origin:'observed',category:'tools',authority:'derived',sequence:1,attributes:[{key:'argument',value:'SECRET_ARGUMENT'}],references:[{kind:'file',id:'SECRET_PATH'}]};
  const text=traceDiagnosticSummary(trace,[base,{...base,sequence:2,duration_origin:'local_observation',end_unix_ms:600},{...base,sequence:3,end_unix_ms:null,status:'error'},{...base,sequence:4,duration_origin:'instant',end_unix_ms:100}],true);
  assert.equal(text.includes('SECRET'),false);
  const result=JSON.parse(text);
  assert.equal(result.observation_gaps,true);
  assert.equal(result.more_spans_omitted,true);
  assert.equal(result.open_spans,1);
  assert.equal(result.error_spans,1);
  assert.equal(result.instant_facts,1);
  assert.deepEqual(result.summed_span_milliseconds,{observed:300,local_observation:500});
  assert.match(result.interpretation,/not an authoritative execution receipt/);
  assert.match(result.interpretation,/not wall-clock/);
});

test('diagnostic aggregate is bounded and declares omitted spans',()=>{
  const trace={trace_id:'a'.repeat(32),method:'workbench',run_id:'attempt',status:'partial',partial:true,updated_at:1};
  const span={start_unix_ms:0,end_unix_ms:null,status:'unset',duration_origin:'observed'};
  const result=JSON.parse(traceDiagnosticSummary(trace,Array.from({length:501},()=>span),false));
  assert.equal(result.included_spans,500);
  assert.equal(result.open_spans,500);
  assert.equal(result.more_spans_omitted,true);
});
