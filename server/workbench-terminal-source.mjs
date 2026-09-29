import {createHash} from 'node:crypto';
import {wbError} from './workbench-store.mjs';

// An observe lease permits owner capture only. This adapter returns one private
// snapshot to the context service; that service must obtain a separate recipient-
// bound disclosure approval. No lease is exposed to Hermes or made reusable there.
export function createWorkbenchTerminalSource({store,records,broker}){
  return async({workspace_id,project_id,resource_id,lease_id})=>{
    if(!broker)throw wbError('unavailable');
    const project=records.project(workspace_id,project_id);
    const resource=records.getResource(workspace_id,project_id,resource_id);
    if(resource.kind!=='terminal'||typeof resource.pane_id!=='string')throw wbError('permission_denied');
    const status=await broker.status();
    const adopted=status.resources.find(item=>(item.pane_id??item.paneId)===resource.pane_id&&(item.workspace_id??item.workspaceId)===workspace_id);
    const lease=status.leases.find(item=>(item.lease_id??item.leaseId)===lease_id);
    if(!adopted||!lease||lease.scope!=='observe'||lease.state!=='active'||(lease.pane_id??lease.paneId)!==resource.pane_id||(lease.resource_id??lease.resourceId)!==(adopted.resource_id??adopted.resourceId))throw wbError('permission_denied');
    const observed=await broker.observe({workspaceId:workspace_id,leaseId:lease_id,baseRevision:store.read(workspace_id).revision,lines:2000});
    if(records.project(workspace_id,project_id).generation!==project.generation)throw wbError('stale_resource');
    const text=observed.text;
    if(typeof text!=='string'||Buffer.byteLength(text)>65536)throw wbError('limit_exceeded');
    const captured_at=observed.observed_at??observed.observedAt??Date.now();
    return {text,hash:createHash('sha256').update(text).digest('hex'),captured_at,resource_id,truncated:true,
      provenance:{kind:'terminal',project_id,resource_id,pane_id:resource.pane_id,captured_at,bounds:{max_lines:2000,max_bytes:65536},note:'Bounded terminal tail; earlier output and environment variables excluded. Capture is not disclosure consent.'}};
  };
}
