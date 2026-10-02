import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

// Authority belongs to one accepted Normal run or an explicit dedicated local
// recipient, never an entire gateway profile. Keys travel out of band, never in
// tool arguments/handler kwargs. Restart invalidates every channel (including old keys).
export async function createResourceDelegation({root,workspaceRead,knowledge,documents,now=Date.now,normalBindings,normalProfiles=JSON.parse(process.env.ORBIT_RESOURCE_NORMAL_PROFILES||'{}')}) {
  if(!normalProfiles||typeof normalProfiles!=='object'||Array.isArray(normalProfiles)||Object.entries(normalProfiles).some(([id,name])=>!/^[a-zA-Z0-9_-]{1,64}$/.test(id)||typeof name!=='string'||name.length>100||/[\x00-\x1f]/.test(name)))fail('invalid_request');
  const dir=path.join(root,'resource-delegation');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
  // This root has one authoritative host writer. A restart never restores keys,
  // including projections left by an abrupt exit. Historical grant JSON is not
  // touched; only the fixed disposable key-file namespaces are invalidated.
  for(const name of fs.readdirSync(dir))if(name.endsWith('.channel.json')&&uuid.test(name.slice(0,-13)))fs.rmSync(path.join(dir,name),{force:true});
  const normalDir=path.join(dir,'normal');
  if(fs.existsSync(normalDir)){
    const stat=fs.lstatSync(normalDir);if(!stat.isDirectory()||stat.isSymbolicLink())fail('unavailable');
    for(const profile of fs.readdirSync(normalDir,{withFileTypes:true})){
      if(!profile.isDirectory()||!/^[a-zA-Z0-9_-]{1,64}$/.test(profile.name))continue;
      const folder=path.join(normalDir,profile.name);
      for(const name of fs.readdirSync(folder))if(/^run_[a-zA-Z0-9_-]{8,100}\.json$/.test(name))fs.rmSync(path.join(folder,name),{force:true});
    }
  }
  // Durable runtime paths can exceed Unix socket limits. Like native Workbench
  // channels, keep only the ephemeral listener in a private short temp directory.
  const socketDir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-resource-'));fs.chmodSync(socketDir,0o700);
  const socket=path.join(socketDir,'tool.sock');
  if(Buffer.byteLength(socket)>100){fs.rmSync(socketDir,{recursive:true,force:true});fail('unavailable');}
  const active=new Map();let closed=false;
  const file=id=>path.join(dir,`${id}.json`);
  function persist(record){const temp=file(record.id)+'.tmp';const fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file(record.id));const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
  function read(id){if(!uuid.test(id??''))fail('invalid_request');let r;try{const f=file(id),s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||s.size>4*1024*1024)fail('unavailable');r=JSON.parse(fs.readFileSync(f,'utf8'));}catch{fail('unavailable');}if(r.version!==1||r.id!==id)fail('unavailable');return r;}
  const publicRecord=r=>({recipient_id:r.id,destination:r.destination,normal:r.normal?{...r.normal.recipient,run_id:r.normal.run_id??null}:null,expires_at:r.expires_at,generation:r.generation,state:r.revoked?'revoked':r.channel_closed?.reason??(now()>=r.expires_at?'expired':!active.has(r.id)?'channel_offline':r.grant?r.normal&&!r.normal.run_id?'awaiting_next_normal_run':'granted':'awaiting_grant'),grant:r.grant?{source_ids:r.grant.sources.map(s=>s.source_id),verbs:r.grant.verbs,source_generation:r.grant.source_generation}:null,operations:Object.entries(r.operations).map(([op_id,op])=>({op_id,request_digest:op.digest,document_id:op.document_id,outcome:op.result?'committed':'unknown'})),remaining:{calls:L.calls-r.calls,read_bytes:L.readBytes-r.read_bytes,documents:L.documents-Object.keys(r.operations).length}});
  function retire(id,reason){
    const r=read(id),entry=active.get(id);
    if(!r.channel_closed){r.channel_closed={reason,at:now()};persist(r);}
    // Only disposable authority is removed. Grant, artifact ID, digest and all
    // pending/committed operation receipts remain in the durable record forever.
    if(entry?.channel_file)fs.rmSync(entry.channel_file,{force:true});
    if(entry)entry.closing=true;
    if(entry&&!entry.busy)active.delete(id);
  }
  function reap(){
    for(const [id] of active){
      const r=read(id);let reason=r.channel_closed?.reason??(r.revoked?'revoked':now()>=r.expires_at?'expired':null);
      if(!reason&&r.normal){try{reason=normalBindings?.retirementReason?.(r.workspace_id,r.normal);}catch{/* Unknown status is not retirement evidence. */}}
      if(reason)retire(id,reason);
    }
  }
  function listing(workspace,after){
    const current=[],history=[];let retained=0,historical=0;
    const directory=fs.opendirSync(dir);
    try{for(let entry;(entry=directory.readSync());){
      if(!entry.name.endsWith('.json')||!uuid.test(entry.name.slice(0,-5)))continue;
      const r=read(entry.name.slice(0,-5));if(r.workspace_id!==workspace)continue;retained++;
      if(active.has(r.id)&&!r.channel_closed){current.push(publicRecord(r));continue;}
      historical++;
      if(after&&r.id<=after)continue;
      history.push(publicRecord(r));history.sort((a,b)=>a.recipient_id.localeCompare(b.recipient_id));
      if(history.length>L.historyPage+1)history.pop();
    }}finally{directory.closeSync();}
    const more=history.length>L.historyPage;if(more)history.pop();
    return {recipients:[...current,...history],capacity:{active_channels:active.size,closing_channels:[...active.values()].filter(entry=>entry.closing).length,limit:L.recipients,available_slots:L.recipients-active.size,retained_records:retained},history:{total:historical,page_size:L.historyPage,shown:history.length,next_after:more?history.at(-1).recipient_id:null}};
  }
  function authorize(id,generation,verb){
    const r=read(id);
    if(closed||!active.has(id))fail('permission_denied');
    if(r.revoked)fail('revoked');if(now()>=r.expires_at)fail('expired');
    if(r.channel_closed)fail('permission_denied');
    if(r.generation!==generation)fail('stale_resource');
    if(!r.grant||verb&&!r.grant.verbs.includes(verb))fail('permission_denied');
    if(r.normal)normalBindings.authorize(r.workspace_id,r.normal);
    knowledge.authorizeSources(r.workspace_id,r.grant.source_generation,r.grant.sources);
    return r;
  }
  async function owner(body){
    fields(body,['action','workspace_id','recipient_id','source_ids','verbs','destination','pane_id','expected_binding_revision','history_after']);
    if(!uuid.test(body.workspace_id??'')||!await workspaceRead(body.workspace_id))fail('permission_denied');
    const ws=body.workspace_id;
    reap();
    if(body.action==='list'){
      fields(body,['action','workspace_id','history_after']);
      if(body.history_after!==undefined&&!uuid.test(body.history_after))fail('invalid_request');
      const normal_recipients=(normalBindings?.list(ws)??[]).filter(r=>Object.hasOwn(normalProfiles,r.profile_id)).map(r=>({...r,adapter_directory:path.join(dir,'normal',r.profile_id),hermes_profile:normalProfiles[r.profile_id]}));
      return {...listing(ws,body.history_after),normal_recipients,normal_gateway:{availability:normal_recipients.length?'configured_unverified':'not_configured',reason:'Requires pinned local gateway adapter and explicit profile mapping; installation is verified only by successful authenticated tool use. Grants bind only the next accepted Normal run'},limits:L};
    }
    if(body.action==='prepare'||body.action==='prepare_normal'){
      let normal=null,destination=body.destination;
      if(body.action==='prepare_normal'){
        fields(body,['action','workspace_id','pane_id','expected_binding_revision']);
        if(!normalBindings||!uuid.test(body.pane_id??''))fail('unavailable');
        const recipient=normalBindings.current({workspace_id:ws,pane_id:body.pane_id});
        if(!Object.hasOwn(normalProfiles,recipient.profile_id))fail('unavailable');
        if(recipient.binding_revision!==body.expected_binding_revision)fail('stale_resource');
        for(const id of active.keys()){const previous=read(id);if(!previous.revoked&&previous.expires_at>now()&&previous.workspace_id===ws&&previous.normal?.recipient.pane_id===body.pane_id&&!previous.normal.run_id)fail('conflict');}
        normal={recipient,hermes_profile:normalProfiles[recipient.profile_id]};destination=recipient.destination;
      }else{
        fields(body,['action','workspace_id','destination']);
        if(typeof destination!=='string'||!destination.trim()||destination.length>200||/[\x00-\x1f]/.test(destination))fail('invalid_request');
      }
      if(active.size>=L.recipients)fail('limit_exceeded');
      const id=randomUUID(),secret=randomBytes(32).toString('hex');
      const r={version:1,id,workspace_id:ws,destination,...(normal?{normal}:{}),expires_at:now()+L.ttlMs,generation:0,revoked:false,grant:null,calls:0,read_bytes:0,operations:{}};persist(r);
      const channel_file=normal?null:path.join(dir,`${id}.channel.json`);
      if(channel_file)fs.writeFileSync(channel_file,JSON.stringify({version:1,socket,secret,recipient_id:id,expires_at:r.expires_at}),{mode:0o600,flag:'wx'});
      active.set(id,{secret,sequence:0,busy:false,channel_file});
      return {...publicRecord(r),channel_file,notice:'Configure resource_channel_file only in a dedicated one-run local Hermes process. Never configure a shared Normal gateway profile.'};
    }
    const r=read(body.recipient_id);if(r.workspace_id!==ws)fail('permission_denied');
    if(body.action==='revoke'){
      fields(body,['action','workspace_id','recipient_id']);r.revoked=true;r.generation++;persist(r);
      retire(r.id,'revoked');return publicRecord(read(r.id));
    }
    if(body.action!=='grant')fail('invalid_request');
    fields(body,['action','workspace_id','recipient_id','source_ids','verbs']);
    if(r.revoked||r.channel_closed||r.grant||!active.has(r.id)||now()>=r.expires_at)fail('permission_denied');
    if(!Array.isArray(body.source_ids)||body.source_ids.length>L.sources||new Set(body.source_ids).size!==body.source_ids.length||body.source_ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))fail('invalid_request');
    if(!Array.isArray(body.verbs)||!body.verbs.length||new Set(body.verbs).size!==body.verbs.length||body.verbs.some(v=>!['search','read_source','create_document'].includes(v)))fail('invalid_request');
    const listed=await knowledge.dispatch({action:'list_sources',workspace_id:ws});
    const sources=body.source_ids.map(id=>{const s=listed.sources.find(s=>s.source_id===id);if(!s)fail('resource_gone');return {source_id:id,content_sha256:s.content_sha256};});
    const current=read(r.id);if(current.generation!==r.generation||current.revoked||current.channel_closed||current.grant||!active.has(r.id)||now()>=current.expires_at)fail('stale_resource');
    if(current.normal){const bound=normalBindings.current({workspace_id:ws,pane_id:current.normal.recipient.pane_id});for(const key of ['profile_id','session_id','binding_revision','config_generation'])if(bound[key]!==current.normal.recipient[key])fail('stale_resource');}
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
    if(r.normal){await normalBindings.validateRun(r.workspace_id,r.normal);r=fence();}
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
      if(owned&&error.channel_retirement==='completed')try{retire(req.headers['x-orbit-recipient'],'completed');}catch{/* Retain the slot/receipt on cleanup IO failure. */}
      const code=codes.has(error.code)?error.code:'unavailable';let outcome='refused';
      if(owned&&body?.action==='create_document'&&uuid.test(body.op_id??'')&&!['operation_mismatch','invalid_request','permission_denied','limit_exceeded'].includes(code)){
        try{const op=read(req.headers['x-orbit-recipient']).operations[body.op_id];if(op&&!op.result)outcome='unknown';}catch{}
      }
      res.statusCode=400;res.end(JSON.stringify({ok:false,code,outcome,...(owned&&uuid.test(body?.op_id??'')?{op_id:body.op_id}:{} )}));
    }
    finally{if(owned){entry.busy=false;try{reap();}catch{/* Retain uncertain channels; owner refresh reports cleanup failure. */}}}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});fs.chmodSync(socket,0o600);}catch(error){fs.rmSync(socketDir,{recursive:true,force:true});throw error;}
  function normalAccepted(receipt){
    if(closed||!/^run_[a-zA-Z0-9_-]{8,100}$/.test(receipt.run_id??''))return;
    reap();
    for(const [id,entry] of active){
      const r=read(id);
      if(!r.normal||r.normal.run_id||!r.grant||r.revoked||r.expires_at<=now()||r.workspace_id!==receipt.workspace_id)continue;
      if(['pane_id','profile_id','session_id','binding_revision','config_generation'].some(key=>r.normal.recipient[key]!==receipt.recipient[key]))continue;
      const normal={...r.normal,run_id:receipt.run_id,receipt_id:receipt.receipt_id,payload_hash:receipt.payload_hash};
      normalBindings.authorize(r.workspace_id,normal);
      r.normal=normal;persist(r); // Consume next-run binding before publishing any authority.
      const folder=path.join(dir,'normal',normal.recipient.profile_id);fs.mkdirSync(folder,{recursive:true,mode:0o700});fs.chmodSync(folder,0o700);
      const channel_file=path.join(folder,`${normal.run_id}.json`),temp=path.join(folder,`${randomUUID()}.tmp`);
      if(fs.existsSync(channel_file))fail('conflict'); // Never alias a second receipt onto an existing run channel.
      fs.writeFileSync(temp,JSON.stringify({version:1,socket,secret:entry.secret,recipient_id:id,run_id:normal.run_id,session_id:normal.recipient.session_id,hermes_profile:normal.hermes_profile,expires_at:r.expires_at}),{mode:0o600,flag:'wx'});
      fs.renameSync(temp,channel_file);entry.channel_file=channel_file;
    }
  }
  return {dispatch:owner,normalAccepted,async close(){closed=true;for(const entry of active.values())if(entry.channel_file)fs.rmSync(entry.channel_file,{force:true});active.clear();await new Promise(resolve=>server.close(resolve));fs.rmSync(socketDir,{recursive:true,force:true});}};
}
