import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {ROOT_CONTEXT,trace,SpanStatusCode} from '@opentelemetry/api';
import {BasicTracerProvider,SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {TRACE_LIMITS,validateTraceSpan} from '../contracts/run-trace-v1.mjs';
import {wbError} from './workbench-store.mjs';
import {traceId,terminal} from './run-trace-project.mjs';

const ns=time=>String(BigInt(Math.round(time*1000))*1000n);
const hr=time=>[Math.floor(time/1000),Math.round((time%1000)*1e6)];
function otlpSpan(span){
  const attributes=[...span.attributes,
    {key:'orbit.duration_origin',value:span.duration_origin},
    {key:'orbit.open',value:span.end_unix_ms===null?1:0},
    {key:'orbit.authority',value:span.authority},
    ...span.references.map(ref=>({key:`orbit.reference.${ref.kind}`,value:ref.id})),
  ];
  return {traceId:span.trace_id,spanId:span.span_id,
    ...(span.parent_span_id?{parentSpanId:span.parent_span_id}:{}),
    name:span.name,kind:1,startTimeUnixNano:ns(span.start_unix_ms),
    ...(span.end_unix_ms===null?{}:{endTimeUnixNano:ns(span.end_unix_ms)}),
    status:{code:span.status==='error'?2:span.status==='ok'?1:0},
    attributes:attributes.map(a=>({key:a.key,value:typeof a.value==='number'?{doubleValue:a.value}:{stringValue:a.value}})),
  };
}
export function createRunTracesStore({root,now=Date.now}){
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const dir=fs.lstatSync(root);if(!dir.isDirectory()||dir.isSymbolicLink())throw wbError('unavailable');
  const filename=path.join(root,'run-traces.sqlite');
  for(const suffix of ['','-wal','-shm']){const file=filename+suffix;if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw wbError('unavailable');}}
  const fd=fs.openSync(filename,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);fs.chmodSync(filename,0o600);
  const db=new Database(filename);db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS traces(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, scope_json TEXT NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL, partial INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS spans(trace_id TEXT NOT NULL, span_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(trace_id,span_id));
    CREATE TABLE IF NOT EXISTS seen(trace_id TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(trace_id,identity));
    CREATE INDEX IF NOT EXISTS trace_workspace ON traces(workspace,updated);
    CREATE INDEX IF NOT EXISTS span_sequence ON spans(trace_id,seq);`);
  for(const suffix of ['-wal','-shm'])if(fs.existsSync(filename+suffix))fs.chmodSync(filename+suffix,0o600);
  // Restart proves an observation gap, never a process termination.
  db.prepare("UPDATE traces SET partial=1,status='partial' WHERE status='running'").run();
  let seed,exported=0;const pending=new Map();
  const exporter={export(spans,done){try{for(const readable of spans){const sdkContext=readable.spanContext();const key=sdkContext.spanId;const span=pending.get(key);if(span){persist({...span,trace_id:sdkContext.traceId,span_id:sdkContext.spanId,name:readable.name,status:readable.status.code===SpanStatusCode.ERROR?'error':readable.status.code===SpanStatusCode.OK?'ok':'unset'});pending.delete(key);exported++;}}done({code:0});}catch(error){done({code:1,error});}},shutdown:async()=>{},forceFlush:async()=>{}};
  const provider=new BasicTracerProvider({idGenerator:{generateTraceId:()=>seed.trace_id,generateSpanId:()=>seed.span_id},spanProcessors:[new SimpleSpanProcessor(exporter)]});
  const tracer=provider.getTracer('orbit-local-run-traces','1');
  function persist(span){db.prepare('INSERT INTO spans VALUES(?,?,?,?) ON CONFLICT(trace_id,span_id) DO UPDATE SET seq=excluded.seq,json=excluded.json').run(span.trace_id,span.span_id,span.sequence,JSON.stringify(span));}
  function remove(id){db.prepare('DELETE FROM spans WHERE trace_id=?').run(id);db.prepare('DELETE FROM seen WHERE trace_id=?').run(id);db.prepare('DELETE FROM traces WHERE id=?').run(id);}
  function get(workspace,id){const row=db.prepare('SELECT * FROM traces WHERE id=? AND workspace=?').get(id,workspace);if(!row)throw wbError('permission_denied');return row;}
  function append(projected){
    const {scope,identity}=projected;let span={...projected.span},timingGap=false;
    return db.transaction(()=>{
      if(db.prepare('SELECT 1 FROM seen WHERE trace_id=? AND identity=?').get(span.trace_id,identity))return null;
      const old=db.prepare('SELECT json FROM spans WHERE trace_id=? AND span_id=?').get(span.trace_id,span.span_id);
      if(old){const previous=JSON.parse(old.json);
        const revision=previous.attributes.find(a=>a.key==='record_revision')?.value;
        if(projected.revision&&revision>=projected.revision)return null;
        const betterStart=projected.hasStart&&span.duration_origin==='observed'&&['local_observation','instant'].includes(previous.duration_origin);
        if(!betterStart)span.start_unix_ms=previous.start_unix_ms;
        if(previous.end_unix_ms!==null&&span.end_unix_ms===null&&terminal(previous.attributes.find(a=>a.key==='source_status')?.value))return null;
        if(previous.duration_origin==='local_observation'&&!betterStart)span.duration_origin='local_observation';
      }else if(projected.terminalOnly){span.start_unix_ms=span.end_unix_ms;span.duration_origin='instant';}
      if(span.end_unix_ms!==null&&span.end_unix_ms<span.start_unix_ms){span.start_unix_ms=span.end_unix_ms;span.duration_origin='instant';timingGap=true;}
      if(!old&&db.prepare('SELECT count(*) n FROM spans WHERE trace_id=?').get(span.trace_id).n>=TRACE_LIMITS.spansPerTrace){db.prepare("UPDATE traces SET partial=1,status='partial' WHERE id=?").run(span.trace_id);return null;}
      const seq=db.prepare('SELECT max(seq) n FROM spans WHERE trace_id=?').get(span.trace_id).n??0;span.sequence=seq+1;
      if(!validateTraceSpan(span)||Buffer.byteLength(JSON.stringify(span))>TRACE_LIMITS.spanBytes)throw wbError('invalid_request');
      let row=db.prepare('SELECT * FROM traces WHERE id=?').get(span.trace_id);
      if(!row){db.prepare('INSERT INTO traces VALUES(?,?,?,?,?,?)').run(span.trace_id,scope.workspace_id,JSON.stringify(scope),'partial',now(),projected.terminalOnly?1:0);row={partial:projected.terminalOnly?1:0,status:'partial'};}
      if(!old&&projected.terminalOnly||timingGap){row.partial=1;db.prepare('UPDATE traces SET partial=1 WHERE id=?').run(span.trace_id);}
      const source=span.attributes.find(a=>a.key==='source_status')?.value;
      const controlsRun=span.parent_span_id===null||scope.method==='workbench'&&span.references[0]?.kind==='grant';
      const status=controlsRun?['unknown','outcome_unknown','dispatch_unknown','inconclusive','expired','revoked','unavailable','acknowledged_unknown','fenced','created','approved','ready'].includes(source)?'partial':span.end_unix_ms===null?'running':span.status==='error'?'failed':'completed':row.status;
      db.prepare('UPDATE traces SET status=?,updated=? WHERE id=?').run(row.partial?'partial':status,now(),span.trace_id);
      db.prepare('INSERT INTO seen VALUES(?,?)').run(span.trace_id,identity);
      // Bound replay identities independently of span count.
      db.prepare('DELETE FROM seen WHERE trace_id=? AND rowid NOT IN (SELECT rowid FROM seen WHERE trace_id=? ORDER BY rowid DESC LIMIT ?)').run(span.trace_id,span.trace_id,TRACE_LIMITS.spansPerTrace*4);
      if(span.end_unix_ms===null)persist(span);
      else {
        seed=span;pending.set(span.span_id,span);
        const parent=span.parent_span_id?trace.setSpanContext(ROOT_CONTEXT,{traceId:span.trace_id,spanId:span.parent_span_id,traceFlags:1}):ROOT_CONTEXT;
        const sdk=tracer.startSpan(span.name,{startTime:hr(span.start_unix_ms),attributes:Object.fromEntries(span.attributes.map(a=>[a.key,a.value]))},parent);
        sdk.setStatus({code:span.status==='error'?SpanStatusCode.ERROR:span.status==='ok'?SpanStatusCode.OK:SpanStatusCode.UNSET});sdk.end(hr(span.end_unix_ms));
        // SimpleSpanProcessor uses our synchronous local exporter; no network or global provider.
        if(pending.has(span.span_id))throw wbError('unavailable');
      }
      const overflow=db.prepare('SELECT id FROM traces WHERE workspace=? ORDER BY updated DESC,id LIMIT -1 OFFSET ?').all(scope.workspace_id,TRACE_LIMITS.tracesPerScope);for(const r of overflow)remove(r.id);
      const totalOverflow=db.prepare('SELECT id FROM traces ORDER BY updated DESC,id LIMIT -1 OFFSET ?').all(TRACE_LIMITS.tracesTotal);for(const r of totalOverflow)remove(r.id);
      return span;
    }).immediate();
  }
  function list(body){const rows=db.prepare('SELECT * FROM traces WHERE workspace=? ORDER BY updated DESC,id').all(body.workspace_id).map(r=>({trace_id:r.id,...JSON.parse(r.scope_json),status:r.status,partial:!!r.partial,updated_at:r.updated}));return {version:1,traces:rows.filter(r=>['profile_id','session_id','method','status'].every(key=>!body[key]||r[key]===body[key])).slice(0,body.limit??200)};}
  function page(body){const row=get(body.workspace_id,body.trace_id);const spans=db.prepare('SELECT json FROM spans WHERE trace_id=? AND seq>? ORDER BY seq LIMIT ?').all(body.trace_id,body.after_sequence??0,(body.limit??500)+1).map(r=>JSON.parse(r.json));const has_more=spans.length>(body.limit??500);if(has_more)spans.pop();return {version:1,spans,after_sequence:spans.at(-1)?.sequence??body.after_sequence??0,has_more,partial:!!row.partial,status:row.status};}
  function exportJson(body){
    const row=get(body.workspace_id,body.trace_id);
    const spans=db.prepare('SELECT json FROM spans WHERE trace_id=? ORDER BY seq').all(body.trace_id).map(r=>JSON.parse(r.json));
    const resource_spans={resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'orbit-local'}},{key:'orbit.projection.partial',value:{boolValue:!!row.partial}}]},scopeSpans:[{scope:{name:'orbit-local-run-traces',version:'1'},spans:spans.map(otlpSpan)}]}]};
    const json=JSON.stringify(resource_spans),bytes=Buffer.byteLength(json);
    if(bytes>TRACE_LIMITS.exportBytes)throw wbError('limit_exceeded');
    return {resource_spans,bytes,sha256:createHash('sha256').update(json).digest('hex'),filename:`trace-${body.trace_id}.json`};
  }
  function retention({workspace_id,dry_run=true}){const expired=db.prepare('SELECT id FROM traces WHERE workspace=? AND updated<?').all(workspace_id,now()-TRACE_LIMITS.retentionDays*86400000);if(!dry_run)db.transaction(()=>{for(const r of expired)remove(r.id);}).immediate();return {removed:dry_run?0:expired.length,eligible:expired.length,dry_run};}
  return {filename,append,list,page,exportJson,retention,markGap(scope){db.prepare("UPDATE traces SET partial=1,status='partial' WHERE id=? AND workspace=?").run(traceId(scope),scope.workspace_id);},detail(body){get(body.workspace_id,body.trace_id);const row=db.prepare('SELECT json FROM spans WHERE trace_id=? AND span_id=?').get(body.trace_id,body.span_id);if(!row)throw wbError('permission_denied');return {span:JSON.parse(row.json)};},remove(body){get(body.workspace_id,body.trace_id);db.transaction(()=>remove(body.trace_id)).immediate();return {removed:true};},sdkExports:()=>exported,close(){void provider.shutdown();db.close();}};
}
