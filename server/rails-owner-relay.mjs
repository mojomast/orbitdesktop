// Narrow, synchronous request/reply bridge over an independently enrolled
// forced-command SSH login. No arbitrary remote command, destination or key.
import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const exact=(obj,keys)=>obj!==null&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).sort().join(',')===keys.slice().sort().join(',');
const refuse=code=>{throw Object.assign(Error('Rails owner request refused'),{code});};
const ns='rizzstack-rails-feedback-v1';
const draftFields=['workspace_id','target_event_id','idempotency_key','category','rating','note'];
function validDraft(d){return d&&UUID.test(d.workspace_id)&&UUID.test(d.idempotency_key)&&typeof d.target_event_id==='string'&&ID.test(d.target_event_id)&&
  d.category==='quality'&&[-1,0,1].includes(d.rating)&&['','[redacted]'].includes(d.note);}
function parseReview(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>3072)refuse('invalid_request');
  let d;try{d=JSON.parse(text);}catch{refuse('invalid_request');}
  const keys=[...draftFields,'schema','owner','ledger_uuid','job_id','authorization_id','authorization_digest','target_hash','expires_at'];
  if(!exact(d,keys)||!validDraft(d)||d.schema!==ns||!UUID.test(d.ledger_uuid)||!Number.isSafeInteger(d.expires_at)||
    ![d.owner,d.job_id,d.authorization_id].every(v=>typeof v==='string'&&ID.test(v))||![d.authorization_digest,d.target_hash].every(v=>/^[a-f0-9]{64}$/.test(v))||
    text!==JSON.stringify(d,keys.sort())+'\n')refuse('invalid_request');return d;
}

export function fixedSshExchange(env){
  const {ORBIT_RAILS_RELAY_IDENTITY:identity,ORBIT_RAILS_RELAY_HOST_KEYS:pins,ORBIT_RAILS_RELAY_USER:user,ORBIT_RAILS_RELAY_PORT:port}=env;
  if(!identity||!pins||![identity,pins].every(p=>isAbsolute(p)&&/^\/[A-Za-z0-9/_.-]+$/.test(p))||!user||!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)||!/^\d{1,5}$/.test(port)||+port<1||+port>65535)return null;
  const args=['-F','none','-T','-a','-x','-i',identity,'-p',port,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','IdentityAgent=none',
    '-o','StrictHostKeyChecking=yes','-o','HostKeyAlias=rails-feedback-coordinator','-o','UpdateHostKeys=no','-o','GlobalKnownHostsFile=/dev/null',
    '-o','UserKnownHostsFile='+pins,'-o','ClearAllForwardings=yes','-o','ConnectTimeout=3',user+'@127.0.0.1','rails-feedback-v1'];
  return body=>new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/ssh',args,{env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:['pipe','pipe','ignore'],timeout:8000,killSignal:'SIGKILL'});
    const chunks=[];let size=0;child.stdin.on('error',()=>{});child.on('error',reject);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>4096)child.kill('SIGKILL');else chunks.push(chunk);});
    child.on('close',code=>{if(code!==0||size>4096)return reject(Error('unavailable'));try{resolve(JSON.parse(Buffer.concat(chunks)));}catch{reject(Error('unavailable'));}});
    child.stdin.end(JSON.stringify(body));
  });
}

export function ownerRelay({workspace,workspaceRead,exchange}){
  if(!workspace||!UUID.test(workspace)||!exchange)return null;
  let active=0;
  return async req=>{
    if(req.url!=='/api/rizzstack/rails/feedback'||req.headers['transfer-encoding']||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')||
        !/^[1-9]\d{0,6}$/.test(req.headers['content-length']||''))refuse('invalid_request');
    const n=+req.headers['content-length'];if(n>8192)refuse('too_large');
    if(active>=4)refuse('capacity');active++;
    const timeout=setTimeout(()=>req.destroy(),12000);timeout.unref();
    try{
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>n)refuse('too_large');chunks.push(chunk);}
      if(bytes!==n)refuse('invalid_request');let o;try{o=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{refuse('invalid_request');}
      let d;if(o?.action==='preview'&&exact(o,['action','draft'])&&exact(o.draft,draftFields)&&validDraft(o.draft))d=o.draft;
      else if(o?.action==='confirm'&&exact(o,['action','review','signature'])&&typeof o.signature==='string'&&/^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]+\n-----END SSH SIGNATURE-----\n?$/.test(o.signature)&&o.signature.length<=2048)d=parseReview(o.review);
      else refuse('invalid_request');
      if(d.workspace_id!==workspace)refuse('forbidden');
      let bound;try{bound=workspaceRead(workspace);}catch{refuse('forbidden');}
      if(bound?.id!==workspace||bound.recovery_policy?.held)refuse('forbidden');
      const reply=await exchange(o);if(reply?.ok!==true)refuse(['forbidden','not_found','source_fork','conflict','invalid_request','capability_unavailable'].includes(reply?.code)?reply.code:'source_unavailable');
      if(o.action==='preview'){
        const checked=parseReview(reply.review);if(!draftFields.every(k=>checked[k]===d[k]))refuse('conflict');return {ok:true,review:reply.review};
      }
      if(typeof reply.event_id!=='string'||!ID.test(reply.event_id)||typeof reply.duplicated!=='boolean')refuse('source_unavailable');
      return {ok:true,event_id:reply.event_id,duplicated:reply.duplicated};
    }finally{clearTimeout(timeout);active--;}
  };
}
