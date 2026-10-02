import {randomUUID} from 'node:crypto';
import {allowedRequest,tokenMatches} from './security.mjs';
import {commandIdentity} from './command-identity.mjs';
import {createLayoutStorage} from './workspace-layouts-storage.mjs';
import {captureLayout,compileSavedLayout,validateSavedLayout} from '../src/saved-workspace-layouts-plan.ts';
import {compileDockingGrid} from '../src/saved-workspace-layouts-grid.ts';
import {arrangementOperations} from '../src/workspace-arrange-plan.ts';
import {applyOperation} from '../src/workspace-ops.ts';

const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
function invalid(message='Invalid layout request'){throw Object.assign(Error(message),{category:'INVALID_OPERATION'});}
export function createWorkspaceLayouts({store,token,port,devOrigins=[],reply,root=store.root}) {
  const storage=createLayoutStorage(root);
  function dispatch(body) {
    const fields={list:[],capture:['name','viewport','base_revision'],rename:['layout_id','name'],delete:['layout_id'],preview:['layout_id','viewport','replacements'],arrange_preview:['window_ids','mode','columns','viewport','base_revision'],apply:['layout','viewport','replacements','base_revision','operation_id','intent']};
    if(!body||typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(fields,body.action)||!uuid(body.workspace_id)||Object.keys(body).some(k=>!['action','workspace_id',...fields[body.action]].includes(k)))invalid();
    const w=body.workspace_id,r=store.read(w);
    if(body.action==='arrange_preview') {
      if(body.base_revision!==r.revision)throw Object.assign(Error('Workspace changed; preview again'),{category:'REVISION_CONFLICT'});
      if(!['grid','compare'].includes(body.mode)||!Array.isArray(body.window_ids)||body.window_ids.length>100)invalid();
      const ops=arrangementOperations(r.state,body.window_ids,body.mode,body.columns,body.viewport);
      const state=ops.reduce((s,op)=>applyOperation(s,op),r.state);
      const placement=compileDockingGrid(r.placement,r.state.monitors.map(m=>m.id),body.window_ids,body.mode==='compare'?2:body.columns);
      const layout=captureLayout(state,placement,body.viewport);
      // Only selected windows are geometry targets; retain all other current frames.
      layout.windows=layout.windows.filter(m=>body.window_ids.includes(m.id));layout.selected=body.window_ids[0];
      layout.placement=compileDockingGrid(undefined,body.window_ids,body.window_ids,body.mode==='compare'?2:body.columns);
      return {base_revision:r.revision,layout,...compileSavedLayout(r,layout,body.viewport)};
    }
    if(['capture','rename'].includes(body.action)&&(typeof body.name!=='string'||!body.name.trim()||body.name.length>80))invalid('Provide a name of 1–80 characters');
    if(['capture','apply'].includes(body.action)&&(!Number.isSafeInteger(body.base_revision)||body.base_revision<0))invalid();
    if(body.action==='apply') {
      if(!uuid(body.operation_id)||typeof body.intent!=='string'||!body.intent.trim()||body.intent.length>160)invalid();
      validateSavedLayout(body.layout);
      // Compile after receipt replay and CAS, inside the synchronous transaction.
      const change={checkpointLabel:'Before saved workspace layout',skipUnchanged:true,
        apply:current=>{const plan=compileSavedLayout(current,body.layout,body.viewport,body.replacements);if(plan.missing.length)invalid('Missing saved windows: '+plan.missing.join(', '));change.placement=plan.placement;return plan.state;},
        response:(record,checkpoint)=>({revision:record.revision,placement_revision:record.placement_revision,checkpoint_id:checkpoint?.id??null,command_receipt:{operation_id:body.operation_id,legacy:false}})};
      const result=store.commit(commandIdentity(body,'owner'),change);return {...result.result,replayed:result.replayed};
    }
    const catalog=storage.read(w);
    if(body.action==='list')return {revision:r.revision,layouts:catalog.map(({id,name,created_at,layout})=>({id,name,created_at,window_count:layout.windows.length}))};
    if(body.action==='capture') {
      if(body.base_revision!==r.revision)throw Object.assign(Error('Workspace changed; refresh before saving'),{category:'REVISION_CONFLICT'});
      if(catalog.length>=32)invalid('At most 32 layouts can be saved');
      const entry={id:randomUUID(),name:body.name.trim(),created_at:Date.now(),layout:captureLayout(r.state,r.placement,body.viewport)};
      storage.write(w,[...catalog,entry]);return {layout_id:entry.id,revision:r.revision};
    }
    if(!uuid(body.layout_id))invalid();const entry=catalog.find(e=>e.id===body.layout_id);if(!entry)throw Object.assign(Error('Saved layout not found'),{code:'ENOENT'});
    if(body.action==='rename'){entry.name=body.name.trim();storage.write(w,catalog);return {layout_id:entry.id};}
    if(body.action==='delete'){storage.write(w,catalog.filter(e=>e.id!==entry.id));return {layout_id:entry.id};}
    const plan=compileSavedLayout(r,entry.layout,body.viewport,body.replacements);
    return {base_revision:r.revision,name:entry.name,layout:entry.layout,...plan};
  }
  return {dispatch,async handle(req,res) {
    const authorization=req.headers.authorization;
    if(req.method!=='POST'||!allowedRequest(req,port,devOrigins)||typeof authorization!=='string'||!authorization.startsWith('Bearer ')||!tokenMatches(authorization.slice(7),token))return reply(res,403,{error:'Workspace owner authentication required'});
    try{const chunks=[];let size=0;for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>131072)return reply(res,413,{error:'Layout request too large'});chunks.push(Buffer.from(chunk));}
      const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));return reply(res,200,dispatch(body));
    }catch(error){const category=error.category;return reply(res,error.code==='ENOENT'?404:category==='RESOURCE_BUSY'?503:['REVISION_CONFLICT','IDEMPOTENCY_CONFLICT','RECOVERY_POLICY_CHANGED','RECOVERY_HOLD','STUDIO_RELEASE_REVOKED'].includes(category)?409:400,{error:error.message,category:category??'INVALID_OPERATION'});}
  }};
}
