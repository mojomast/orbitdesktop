import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import Ajv from 'ajv';
import {RESOURCE_LIMITS as L,resourceToolSchema,RESOURCE_ACTION_FIELDS} from '../contracts/resource-tools-v1.mjs';
import {briefData,resourceDigest} from './resource-documents.mjs';
const valid=new Ajv({strict:false}).compile(resourceToolSchema);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail=code=>{throw Object.assign(Error(code),{code});};
const fields=(body,keys)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))fail('invalid_request');};
const codes=new Set(['invalid_request','permission_denied','expired','revoked','resource_gone','stale_resource','limit_exceeded','busy','operation_mismatch','unavailable','conflict']);

// A dedicated local adapter is the recipient. This is deliberately NOT a profile-
// wide Normal gateway grant. All authority is supplied out of band, never in tool
// arguments/handler kwargs. Restart invalidates every channel (including old keys).
export async function createResourceDelegation({root,workspaceRead,knowledge,documents,now=Date.now}) {
  const dir=path.join(root,'resource-delegation');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
  const socket=path.join(dir,`s-${randomBytes(4).toString('hex')}.sock`);
  if(Buffer.byteLength(socket)>100)fail('unavailable');
  const active=new Map();let closed=false;
  const file=id=>path.join(dir,`${id}.json`);
  function persist(record){const temp=file(record.id)+'.tmp';const fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file(record.id));const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
  function read(id){if(!uuid.test(id??''))fail('invalid_request');let r;try{const f=file(id),s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||s.size>4*1024*1024)fail('unavailable');r=JSON.parse(fs.readFileSync(f,'utf8'));}catch{fail('unavailable');}if(r.version!==1||r.id!==id)fail('unavailable');return r;}
  const publicRecord=r=>({recipient_id:r.id,destination:r.destination,expires_at:r.expires_at,generation:r.generation,state:r.revoked?'revoked':!active.has(r.id)?'channel_offline':now()>=r.expires_at?'expired':r.grant?'granted':'awaiting_grant',grant:r.grant?{source_ids:r.grant.sources.map(s=>s.source_id),verbs:r.grant.verbs,source_generation:r.grant.source_generation}:null,remaining:{calls:L.calls-r.calls,read_bytes:L.readBytes-r.read_bytes,documents:L.documents-Object.keys(r.operations).length}});
  function authorize(id,generation,verb){
    const r=read(id);
    if(closed||!active.has(id))fail('permission_denied');
    if(r.revoked)fail('revoked');if(now()>=r.expires_at)fail('expired');
    if(r.generation!==generation)fail('stale_resource');
    if(!r.grant||verb&&!r.grant.verbs.includes(verb))fail('permission_denied');
    knowledge.authorizeSources(r.workspace_id,r.grant.source_generation,r.grant.sources);
    return r;
  }
  async function owner(body){
    fields(body,['action','workspace_id','recipient_id','source_ids','verbs','destination']);
    if(!uuid.test(body.workspace_id??'')||!await workspaceRead(body.workspace_id))fail('permission_denied');
    const ws=body.workspace_id;
    if(body.action==='list'){
      fields(body,['action','workspace_id']);
      return {recipients:fs.readdirSync(dir).filter(n=>uuid.test(n.slice(0,-5))&&n.endsWith('.json')).map(n=>read(n.slice(0,-5))).filter(r=>r.workspace_id===ws).map(publicRecord),normal_gateway:{availability:'unsupported',reason:'No authenticated per-run plugin channel in the pinned Runs gateway'},limits:L};
    }
    if(body.action==='prepare'){
      fields(body,['action','workspace_id','destination']);
      if(typeof body.destination!=='string'||!body.destination.trim()||body.destination.length>200||/[\x00-\x1f]/.test(body.destination))fail('invalid_request');
      if(fs.readdirSync(dir).filter(n=>n.endsWith('.json')&&!n.endsWith('.channel.json')).length>=L.recipients)fail('limit_exceeded');
      const id=randomUUID(),secret=randomBytes(32).toString('hex');
      const r={version:1,id,workspace_id:ws,destination:body.destination,expires_at:now()+L.ttlMs,generation:0,revoked:false,grant:null,calls:0,read_bytes:0,operations:{}};persist(r);
      const channel_file=path.join(dir,`${id}.channel.json`);
      fs.writeFileSync(channel_file,JSON.stringify({version:1,socket,secret,recipient_id:id}),{mode:0o600,flag:'wx'});
      active.set(id,{secret,sequence:0,busy:false,channel_file});
      return {...publicRecord(r),channel_file,notice:'Configure resource_channel_file only in a dedicated one-run local Hermes process. Never configure a shared Normal gateway profile.'};
    }
    const r=read(body.recipient_id);if(r.workspace_id!==ws)fail('permission_denied');
    if(body.action==='revoke'){
      fields(body,['action','workspace_id','recipient_id']);r.revoked=true;r.generation++;persist(r);
      const entry=active.get(r.id);if(entry)fs.rmSync(entry.channel_file,{force:true});
      return publicRecord(r);
    }
    if(body.action!=='grant')fail('invalid_request');
    fields(body,['action','workspace_id','recipient_id','source_ids','verbs']);
    if(r.revoked||r.grant||!active.has(r.id)||now()>=r.expires_at)fail('permission_denied');
    if(!Array.isArray(body.source_ids)||body.source_ids.length>L.sources||new Set(body.source_ids).size!==body.source_ids.length||body.source_ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))fail('invalid_request');
    if(!Array.isArray(body.verbs)||!body.verbs.length||new Set(body.verbs).size!==body.verbs.length||body.verbs.some(v=>!['search','read_source','create_document'].includes(v)))fail('invalid_request');
    const listed=await knowledge.dispatch({action:'list_sources',workspace_id:ws});
    const sources=body.source_ids.map(id=>{const s=listed.sources.find(s=>s.source_id===id);if(!s)fail('resource_gone');return {source_id:id,content_sha256:s.content_sha256};});
    const current=read(r.id);if(current.generation!==r.generation||current.revoked||current.grant)fail('stale_resource');
    knowledge.authorizeSources(ws,listed.consent_generation,sources);
    current.generation++;current.grant={sources,source_generation:listed.consent_generation,verbs:body.verbs};persist(current);return publicRecord(current);
  }
  async function tool(id,body){
    if(!valid(body))fail('invalid_request');
    const keys=RESOURCE_ACTION_FIELDS[body.action];fields(body,['action',...keys]);
    const required={search:['query'],read_source:['source_id'],create_document:['op_id','title','text','citations'],receipt:['op_id']}[body.action]??[];
    if(required.some(k=>body[k]===undefined))fail('invalid_request');
    let r=read(id);const generation=r.generation;
    const verb=['describe','receipt'].includes(body.action)?null:body.action;
    const fence=()=>authorize(id,generation,verb);r=fence();
    if(body.action==='describe')return {ok:true,...publicRecord(r),sources:r.grant.sources,actions:r.grant.verbs,schema:resourceToolSchema,open:{available:false,reason:'Save and workspace opening are separate operations'}};
    if(body.action==='receipt'){
      const operation=r.operations[body.op_id];
      return {ok:true,found:!!operation,...(operation?{op_id:body.op_id,request_digest:operation.digest,outcome:operation.result?'committed':'unknown',result:operation.result??null}:{} )};
    }
    if(r.calls>=L.calls)fail('limit_exceeded');r.calls++;persist(r);
    if(body.action==='create_document'){
      if(Buffer.byteLength(body.text)>L.documentBytes)fail('limit_exceeded');
      const digest=resourceDigest(body),old=r.operations[body.op_id];
      if(old&&old.digest!==digest)fail('operation_mismatch');
      if(old?.result)return old.result;
      if(!old&&Object.keys(r.operations).length>=L.documents)fail('limit_exceeded');
      for(const citation of body.citations){
        if(!r.grant.sources.some(s=>s.source_id===citation.source_id&&s.content_sha256===citation.content_sha256))fail('permission_denied');
        const source=await knowledge.dispatch({action:'get_source',workspace_id:r.workspace_id,source_id:citation.source_id},fence);fence();
        if(citation.char_end<=citation.char_start||citation.char_end>source.text.length)fail('invalid_request');
      }
      const document_id=old?.document_id??randomUUID(),data=briefData(body.text,body.citations,id);
      r=fence();r.operations[body.op_id]=old??{digest,document_id};persist(r);
      const result=await documents.dispatch({action:'create_content',workspace_id:r.workspace_id,document_id,op_id:body.op_id,intent:'Delegated new brief',title:body.title,data},fence);
      r=fence();const saved={ok:true,outcome:'committed',op_id:body.op_id,request_digest:digest,document_id,artifact_uri:`orbit://document/${document_id}`,content_sha256:resourceDigest(data),revision:result.revision,saved:true,opened:false,browser_acknowledged:false};
      r.operations[body.op_id].result=saved;persist(r);return saved;
    }
    let result;
    if(body.action==='search')result=await knowledge.dispatch({action:'search',workspace_id:r.workspace_id,query:body.query,source_ids:r.grant.sources.map(s=>s.source_id),mode:'keyword',limit:10},fence);
    else {
      if(!r.grant.sources.some(s=>s.source_id===body.source_id))fail('permission_denied');
      const source=await knowledge.dispatch({action:'get_source',workspace_id:r.workspace_id,source_id:body.source_id},fence);
      const start=Math.min(body.offset??0,source.text.length),end=Math.min(start+(body.length??8000),source.text.length);
      result={source_id:source.source_id,content_sha256:source.content_sha256,text_sha256:source.text_sha256,text:source.text.slice(start,end),char_start:start,char_end:end,offset_unit:'utf16',total_characters:source.text.length,truncated:end<source.text.length};
    }
    r=fence();const bytes=Buffer.byteLength(JSON.stringify(result));if(r.read_bytes+bytes>L.readBytes)fail('limit_exceeded');r.read_bytes+=bytes;persist(r);
    return {ok:true,result,grant_generation:generation,source_generation:r.grant.source_generation,disclosure_destination:r.destination};
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');let entry,body,owned=false;
    try{
      if(req.method!=='POST'||req.url!=='/tool')fail('permission_denied');
      const id=req.headers['x-orbit-recipient'];entry=active.get(id);if(!entry)fail('permission_denied');
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>150000)fail('limit_exceeded');chunks.push(chunk);}const raw=Buffer.concat(chunks);
      const seq=req.headers['x-orbit-sequence'],mac=req.headers['x-orbit-mac'];
      if(!/^[1-9][0-9]{0,9}$/.test(seq??'')||Number(seq)<=entry.sequence||!/^[a-f0-9]{64}$/.test(mac??''))fail('permission_denied');
      const expected=createHmac('sha256',entry.secret).update(`${seq}\n`).update(raw).digest();
      if(!timingSafeEqual(expected,Buffer.from(mac,'hex')))fail('permission_denied');
      if(entry.busy)fail('busy');entry.sequence=Number(seq);entry.busy=true;owned=true;
      try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{fail('invalid_request');}
      const result=await tool(id,body);res.end(JSON.stringify(result));
    }catch(error){
      const code=codes.has(error.code)?error.code:'unavailable';let outcome='refused';
      if(owned&&body?.action==='create_document'&&uuid.test(body.op_id??'')&&!['operation_mismatch','invalid_request','permission_denied','limit_exceeded'].includes(code)){
        try{const op=read(req.headers['x-orbit-recipient']).operations[body.op_id];if(op&&!op.result)outcome='unknown';}catch{}
      }
      res.statusCode=400;res.end(JSON.stringify({ok:false,code,outcome,...(owned&&uuid.test(body?.op_id??'')?{op_id:body.op_id}:{} )}));
    }
    finally{if(owned)entry.busy=false;}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});fs.chmodSync(socket,0o600);
  return {dispatch:owner,async close(){closed=true;for(const entry of active.values())fs.rmSync(entry.channel_file,{force:true});active.clear();await new Promise(resolve=>server.close(resolve));fs.rmSync(socket,{force:true});}};
}
