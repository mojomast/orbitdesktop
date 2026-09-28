import {WorkbenchStore} from './workbench-store.mjs';

const actions=new Set(['recipe_list','recipe_save','recipe_preview','recipe_apply','proposal_list','proposal_get','proposal_reject']);

// The Normal controller shares the layout-only compiler. Never forward generic
// Workbench routes, candidate/execution actions or an actor supplied by a model.
export function createArrangementControl(store) {
  let service;
  return async (body,actor)=>{
    const request=body.request;
    if(!request||typeof request!=='object'||Array.isArray(request)||Object.hasOwn(request,'workspace_id')||Object.hasOwn(request,'actor')||!actions.has(request.action))
      throw Object.assign(Error('Unsupported arrangement request'),{category:'INVALID_OPERATION'});
    service??=import('./workspace-arrangements.mjs').then(({createWorkspaceArrangements})=>createWorkspaceArrangements({store,records:new WorkbenchStore(store)}));
    try {return await (await service).dispatch({...request,workspace_id:body.workspace_id},{actor});}
    catch(error){
      error.category??=({permission_denied:'PERMISSION_REQUIRED',stale_resource:'REVISION_CONFLICT',conflict:'REVISION_CONFLICT',expired:'REVISION_CONFLICT',limit_exceeded:'REQUEST_TOO_LARGE',invalid_request:'INVALID_OPERATION'})[error.code];
      throw error;
    }
  };
}
