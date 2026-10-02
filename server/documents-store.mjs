import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import Ajv from 'ajv';
import {DOCUMENT_LIMITS,DOCUMENT_UUID,documentsRequestSchema,validateDocumentData,EMPTY_RICHDOC,EMPTY_CANVAS} from '../contracts/documents-v1.mjs';
import {allowedRequest,tokenMatches} from './security.mjs';
const validate = new Ajv({strict:false}).compile(documentsRequestSchema);
const uuid = new RegExp(DOCUMENT_UUID);
const fail = (code,extra={}) => {throw Object.assign(Error(code),{code,...extra});};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const metadata = r => ({id:r.id,kind:r.data.kind,format:r.data.format,title:r.title,revision:r.revision,updated_at:r.updated_at,data_schema_version:1});
// One synchronous writer per root. Content and its receipts commit in the same
// atomic file, eliminating the crash gap of a separate receipt journal.
export function createDocumentsService({root,workspaceRead}) {
  const base=path.join(root,'documents');
  function directory(dir) {
    try {const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()) fail('unavailable');}
    catch(e) {if(e.code!=='ENOENT') throw e;fs.mkdirSync(dir,{mode:0o700});}
    fs.chmodSync(dir,0o700);
  }
  function folder(w) {directory(base);const dir=path.join(base,w);directory(dir);return dir;}
  function read(w,id) {
    const file=path.join(folder(w),`${id}.json`);
    let text;
    try {const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>2*1024*1024) fail('unavailable');text=fs.readFileSync(file,'utf8');}
    catch(e) {if(e.code==='ENOENT') return null;throw e;}
    try {
      const r=JSON.parse(text);
      if (!r || Object.keys(r).sort().join(',')!=='data,id,receipts,revision,title,updated_at,version,workspace_id' || r.version!==1 || r.id!==id || r.workspace_id!==w || !Number.isSafeInteger(r.revision) || r.revision<1 || typeof r.title!=='string' || !r.title.length || r.title.length>160 || /[\x00-\x1f\x7f]/.test(r.title) || typeof r.updated_at!=='string' || !Array.isArray(r.receipts) || r.receipts.length>DOCUMENT_LIMITS.receipts) fail('unavailable');
      validateDocumentData(r.data);
      for (const receipt of r.receipts) if (!receipt || Object.keys(receipt).sort().join(',')!=='digest,op_id,result' || !uuid.test(receipt.op_id) || !/^[a-f0-9]{64}$/.test(receipt.digest) || !receipt.result || Object.keys(receipt.result).sort().join(',')!=='data_schema_version,document_id,revision' || receipt.result.document_id!==id || receipt.result.data_schema_version!==1 || !Number.isSafeInteger(receipt.result.revision) || receipt.result.revision<1 || receipt.result.revision>r.revision) fail('unavailable');
      return r;
    } catch {fail('unavailable');}
  }
  function write(w,r) {
    const dir=folder(w), temp=path.join(dir,`${randomUUID()}.tmp`), fd=fs.openSync(temp,'wx',0o600);
    try {
      try {fs.writeFileSync(fd,JSON.stringify(r));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(temp,path.join(dir,`${r.id}.json`));
      const d=fs.openSync(dir,'r');try {fs.fsyncSync(d);} finally {fs.closeSync(d);}
    } finally {try {fs.unlinkSync(temp);} catch {}}
  }
  function pane(state,id) {
    function walk(n) {if(!n) return null;if(n.type==='pane') return n.pane?.id===id?n.pane:null;return walk(n.a)||walk(n.b)||walk(n.first)||walk(n.second);}
    for(const monitor of state?.monitors??[]) {const p=walk(monitor.layout);if(p)return p;}
    return null;
  }
  async function dispatch(body, authorize = () => {}) {
    if(!validate(body)) fail('invalid_request');
    const snapshot=await workspaceRead(body.workspace_id);
    authorize(); // Internal trusted delegation hook; never a JSON request field.
    if(!snapshot) fail('unavailable');
    const state=snapshot.state??snapshot;
    if(body.pane_id) {const p=pane(state,body.pane_id);if(p?.kind!=='browser'||p.url!==`orbit://document/${body.document_id}`) fail('permission_denied');}
    const w=body.workspace_id;
    if(body.action==='list') {
      const names=fs.readdirSync(folder(w)).filter(n=>uuid.test(n.slice(0,-5))&&n.endsWith('.json'));
      if(names.length>DOCUMENT_LIMITS.documents) fail('limit_exceeded');
      return {documents:names.map(n=>metadata(read(w,n.slice(0,-5)))),limits:DOCUMENT_LIMITS};
    }
    let r=read(w,body.document_id);
    if(body.action==='receipt') {
      if(!r)fail('unavailable');const receipt=r.receipts.find(x=>x.op_id===body.op_id);
      return {found:!!receipt,...(receipt?{result:receipt.result}:{})};
    }
    if(body.action==='read'||body.action==='resolve') {
      if(!r)fail('unavailable');return {document:metadata(r),revision:r.revision,data_schema_version:1,...(body.action==='read'?{data:r.data}:{})};
    }
    const digest=hash(body), previous=r?.receipts.find(x=>x.op_id===body.op_id);
    if(previous) {if(previous.digest!==digest)fail('conflict',{reason:'operation_mismatch'});return previous.result;}
    if(body.action==='create'||body.action==='create_content') {
      if(r) fail('conflict',{revision:r.revision});
      if(fs.readdirSync(folder(w)).filter(n=>n.endsWith('.json')).length>=DOCUMENT_LIMITS.documents)fail('limit_exceeded');
      r={version:1,id:body.document_id,workspace_id:w,title:body.title,revision:0,updated_at:'',data:{kind:body.kind,format:body.kind==='richtext'?'lexical':'excalidraw',content:body.kind==='richtext'?EMPTY_RICHDOC:EMPTY_CANVAS},receipts:[]};
      if(body.action==='create_content'){validateDocumentData(body.data);r.data=body.data;}
    } else {
      if(!r)fail('unavailable');
      if(r.revision!==body.expected_revision)fail('conflict',{revision:r.revision});
      if(body.action==='save') {validateDocumentData(body.data);if(body.data.kind!==r.data.kind)fail('invalid_request');r.data=body.data;}
      else r.title=body.title;
    }
    if(r.revision>=Number.MAX_SAFE_INTEGER-1)fail('limit_exceeded');
    r.revision++;r.updated_at=new Date().toISOString();
    const result={document_id:r.id,revision:r.revision,data_schema_version:1};
    r.receipts=[...r.receipts,{op_id:body.op_id,digest,result}].slice(-DOCUMENT_LIMITS.receipts);
    authorize();write(w,r);return result;
  }
  return {dispatch};
}
// Unlike the Workbench wrapper, this preserves the CAS revision in an error.
export function createDocumentsRoute({token,port,devOrigins,reply,dispatch}) {
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST')return reply(res,405,{ok:false,code:'invalid_request'});
    const auth=req.headers.authorization??'';
    if(!allowedRequest(req,port,devOrigins)||!auth.startsWith('Bearer ')||!tokenMatches(auth.slice(7),token))return reply(res,403,{ok:false,code:'permission_denied'});
    try {
      let size=0;const chunks=[];for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>4*1024*1024)fail('limit_exceeded');chunks.push(Buffer.from(chunk));}
      let body;try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('invalid_request');}
      return reply(res,200,{...await dispatch(body),ok:true});
    } catch(error) {
      const codes={invalid_request:400,permission_denied:403,unavailable:404,conflict:409,limit_exceeded:413,unsupported:422};
      const code=Object.hasOwn(codes,error.code)?error.code:'unavailable';
      return reply(res,codes[code],{ok:false,code,...(Number.isSafeInteger(error.revision)?{revision:error.revision}:{}),...(error.reason==='operation_mismatch'?{reason:error.reason}:{})});
    }
  };
}
