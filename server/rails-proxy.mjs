// Orbit authenticates the shell. Only the fixed backend gets the Rails reader.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {acceptedHosts, allowedRequest, tokenMatches} from './security.mjs';

const PREFIX='/api/rizzstack/rails/';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const CURSOR=/^[A-Za-z0-9._~:=+-]{1,1024}$/;
const CODES=new Map(Object.entries({invalid_request:400,auth_required:401,forbidden:403,not_found:404,conflict:409,source_fork:409,stale_fence:409,reset_required:409,too_large:413,capacity:429,source_unavailable:503,storage_full:503,capability_unavailable:503}));
const RESPONSE_HEADERS={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const READ=new Set(['health','events','view','stream','feedback/export']);

async function privateReader(file) {
  if(!isAbsolute(file))return null;
  const fd=await open(file,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
  try {
    const stat=await fd.stat();if(!stat.isFile()||stat.mode&0o077||stat.size>514)return null;
    const buffer=Buffer.alloc(515);const {bytesRead}=await fd.read(buffer,0,buffer.length,0);
    return buffer.subarray(0,bytesRead).toString('utf8').replace(/\r?\n$/,'');
  }finally{await fd.close();}
}

function fail(res,code) {
  if(res.destroyed || res.headersSent) {res.destroy();return;}
  res.writeHead(CODES.get(code),{...RESPONSE_HEADERS,'Content-Type':'application/json'});
  res.end(JSON.stringify({ok:false,error:{code,retryable:['capacity','source_unavailable'].includes(code),request_id:randomUUID()}}));
}

function validQuery(route, q) {
  if(route==='health') return !q.size;
  const allowed=['kind','id'];
  if(route!=='stream') allowed.push('limit','after','format');
  if(['events','view'].includes(route)) allowed.push('max_bytes','include','show_tokens');
  if([...q.keys()].some(k=>!allowed.includes(k)||q.getAll(k).length!==1))return false;
  const uint=(k,max)=>!q.has(k)||(/^[1-9]\d{0,5}$/.test(q.get(k))&&Number(q.get(k))<=max);
  return ['attempt','job','campaign','session','event'].includes(q.get('kind')) && ID.test(q.get('id')||'') &&
    uint('limit',500)&&uint('max_bytes',32768)&&(!q.has('after')||CURSOR.test(q.get('after')))&&
    (route==='feedback/export'?['csv','jsonl'].includes(q.get('format')):!q.has('format')||['markdown','json'].includes(q.get('format')))&&
    (!q.has('include')||/^(?:tools|verification|review|feedback)(?:,(?:tools|verification|review|feedback)){0,3}$/.test(q.get('include')))&&
    (!q.has('show_tokens')||['true','false'].includes(q.get('show_tokens')));
}

export function createRailsProxy({token,port,devOrigins=[],upstreamPort,readToken,readTokenFile,ownerFeedback=null}) {
  let streams=0, active=0;
  return async function handle(req,res) {
    const raw=req.url||'';
    // Browsers omit Origin on same-origin GET. Fetch Metadata is browser-owned;
    // never synthesize an Origin from Host, Referer or a forwarded header.
    const supplied=req.headers.authorization;
    if(!supplied)return fail(res,'auth_required');
    const originOk=allowedRequest(req,port,devOrigins)||
      (req.method==='GET'&&req.headers.origin===undefined&&req.headers['sec-fetch-site']==='same-origin'&&acceptedHosts(port,devOrigins).hosts.has(req.headers.host));
    if(!originOk||req.headers['sec-fetch-site']==='cross-site'||typeof supplied!=='string'||!supplied.startsWith('Bearer ')||!tokenMatches(supplied.slice(7),token))return fail(res,'forbidden');
    const url=new URL(raw,'http://localhost');
    const route=url.pathname.slice(PREFIX.length);
    if(!raw.startsWith(PREFIX)||raw.split('?')[0]!==PREFIX+route)return fail(res,'not_found');
    if(req.method==='POST'&&['feedback','interventions'].includes(route)){
      if(route!=='feedback'||!ownerFeedback)return fail(res,'capability_unavailable');
      try{const receipt=await ownerFeedback(req);res.writeHead(200,{...RESPONSE_HEADERS,'Content-Type':'application/json'});return res.end(JSON.stringify(receipt));}
      catch(e){return fail(res,CODES.has(e?.code)?e.code:'source_unavailable');}
    }
    if(req.method!=='GET'||!READ.has(route))return fail(res,'not_found');
    if(raw.length>4096||req.headers['transfer-encoding']||Number(req.headers['content-length']||0)!==0||!validQuery(route,url.searchParams))return fail(res,'invalid_request');
    const last=req.headers['last-event-id'];
    if(last!==undefined&&(route!=='stream'||!CURSOR.test(last)))return fail(res,'invalid_request');
    const backendPort=Number(upstreamPort);
    if(!Number.isInteger(backendPort)||backendPort<1||backendPort>65535||backendPort===port)return fail(res,'source_unavailable');
    const stream=route==='stream';
    if(active>=32||(stream&&streams>=8))return fail(res,'capacity');
    active++;if(stream)streams++;
    let backend, timer, released=false;
    const release=()=>{if(released)return;released=true;active--;if(stream)streams--;clearTimeout(timer);backend?.destroy();};
    res.once('close',release);
    try {
      const reader=readTokenFile?await privateReader(readTokenFile):readToken;
      if(released)return;
      if(typeof reader!=='string'||!/^[A-Za-z0-9._~+/=-]{16,512}$/.test(reader)||tokenMatches(reader,token))return fail(res,'source_unavailable');
      backend=http.request({hostname:'127.0.0.1',port:backendPort,path:'/v1/'+route+url.search,method:'GET',agent:false,
        headers:{Authorization:'Bearer '+reader,Accept:stream?'text/event-stream':'*/*',...(last?{'Last-Event-ID':last}:{})}});
      // Reopen long streams through both authorization boundaries periodically.
      timer=setTimeout(()=>{backend.destroy();fail(res,'source_unavailable');},stream?300_000:30_000);timer.unref();
      backend.setTimeout(35_000,()=>backend.destroy());
      backend.on('error',()=>fail(res,'source_unavailable'));
      backend.on('response',async upstream=>{
        try {
          const status=upstream.statusCode;
          if(status>=300&&status<400)throw Error();
          const type=String(upstream.headers['content-type']||'').split(';')[0].toLowerCase();
          const expected=stream?'text/event-stream':route==='feedback/export'?(url.searchParams.get('format')==='csv'?'text/csv':'application/x-ndjson'):'application/json';
          const headers={...RESPONSE_HEADERS,'Content-Type':expected};
          if(status===200&&type!==expected&&!(expected==='application/x-ndjson'&&['application/jsonl','application/jsonlines'].includes(type)))throw Error();
          for(const name of ['x-rails-next-cursor','x-rails-stream-cursor']) {
            const value=upstream.headers[name]; if(value && CURSOR.test(value))headers[name]=value;
          }
          for(const name of ['x-rails-truncated','x-rails-has-more']) {
            const value=upstream.headers[name]; if(['true','false'].includes(value))headers[name]=value;
          }
          if(stream&&status===200) {
            headers['X-Accel-Buffering']='no';res.writeHead(200,headers);res.flushHeaders();
            // Node streams propagate backpressure; drop a blocked browser rather
            // than accumulating an unbounded replay buffer.
            res.setTimeout(35_000,()=>res.destroy());upstream.on('error',()=>res.destroy());upstream.pipe(res);return;
          }
          const chunks=[];let size=0;
          for await(const chunk of upstream){size+=chunk.length;if(size>131072)throw Error();chunks.push(chunk);}
          const body=Buffer.concat(chunks);
          if(status!==200){const code=JSON.parse(body).error?.code;return fail(res,CODES.get(code)===status?code:'source_unavailable');}
          if(type==='application/json')JSON.parse(body);
          res.writeHead(200,headers);res.end(body);
        }catch{upstream.destroy();fail(res,'source_unavailable');}
      });
      backend.end();
    }catch{fail(res,'source_unavailable');}
  };
}
