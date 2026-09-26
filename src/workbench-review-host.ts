import {el,button} from './dom';
import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';
import {workspaceFetch} from './workspace-client';
import {mountWorkbenchReviewView} from './workbench-review-view';

export const REVIEW_URL='orbit://workbench-review';
type Data=Record<string,any>;
async function owner(token:string,body:Data):Promise<Data>{
  if(!token)throw Error('permission_denied');
  const response=await fetch('/api/workbench',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:workspaceId,...body})});
  const value=await response.json();if(!response.ok||value.ok!==true)throw Error(value.code??'unavailable');return value;
}

// The reserved URL carries no authority or project hint. Resolve the pane's
// durable owner-created binding in the current workspace before any private read.
export function mountWorkbenchReviewHost(body:HTMLElement,paneId:string,getToken:()=>string):()=>void{
  let disposed=false,loading=false,epoch=0,key='',view:ReturnType<typeof mountWorkbenchReviewView>|null=null;
  function clear(){epoch++;view?.dispose();view=null;key='';body.replaceChildren();}
  async function refresh(){
    if(disposed||loading)return;
    const token=getToken();
    if(!token){clear();body.append(el('p','','Unlock this workspace to read its bound candidate review.'));return;}
    loading=true;const ticket=epoch;
    try{
      const data=await owner(token,{action:'list'});
      if(disposed||ticket!==epoch||token!==getToken())return;
      const bindings=(data.bindings??[]).filter((binding:Data)=>binding.pane_id===paneId&&binding.role==='candidate_diff'&&data.projects.some((p:Data)=>p.id===binding.project_id&&p.active!==false));
      if(bindings.length!==1){clear();body.append(el('p','','This Review pane needs one active project binding. Open the project’s “Open candidate Review view” control to create or reconnect it.'));return;}
      const binding=bindings[0],next=JSON.stringify([token,binding.id,binding.project_id]);
      if(next===key)return;
      clear();key=next;
      view=mountWorkbenchReviewView(body,{paneId,getToken,workspace_id:workspaceId,project_id:binding.project_id});
    }catch{if(!disposed&&ticket===epoch){clear();body.append(el('p','','Candidate review authorization is unavailable.'),button('Retry review binding','Read the current project binding',()=>void refresh()));}}
    finally{loading=false;}
  }
  const changed=()=>{clear();void refresh();};
  window.addEventListener('orbit-host-connected',changed);
  window.addEventListener('orbit-workbench-review-bound',changed);
  const timer=setInterval(()=>void refresh(),3000);void refresh();
  return ()=>{disposed=true;clearInterval(timer);window.removeEventListener('orbit-host-connected',changed);window.removeEventListener('orbit-workbench-review-bound',changed);clear();};
}

// Explicit owner action only. Reuse an existing bound review instead of mounting
// another live session. Workspace mutations use normal revision CAS/receipts.
export async function openWorkbenchReview(projectId:string,getToken:()=>string):Promise<void>{
  await ensureWorkspaceSynced();
  const token=getToken();
  const api=async(body:Data)=>{const value=await owner(token,body);if(token!==getToken())throw Error('stale_resource');return value;};
  const workspace=async(body:Data)=>{const response=await workspaceFetch(token,{workspace_id:workspaceId,...body});const value=await response.json();if(token!==getToken())throw Error('stale_resource');if(!response.ok)throw Error(value.category??value.code??'unavailable');return value;};
  const listed=await api({action:'list'}),project=listed.projects.find((item:Data)=>item.id===projectId&&item.active!==false);
  if(!project)throw Error('permission_denied');
  const inspected=await api({action:'inspect',project_id:projectId});
  const resource=inspected.resources.find((item:Data)=>item.kind==='file');
  if(!resource)throw Error('No captured file is available to bind a candidate Review view.');
  const current=await workspace({action:'read'});
  const panes:Data[]=[];
  const visit=(node:Data,windowId:string)=>{if(node.type==='pane')panes.push({...node.pane,window_id:windowId});else{visit(node.first,windowId);visit(node.second,windowId);}};
  for(const monitor of current.state.monitors)visit(monitor.layout,monitor.id);
  const matches=panes.filter(p=>p.kind==='browser'&&p.url===REVIEW_URL&&listed.bindings.some((b:Data)=>b.project_id===projectId&&b.pane_id===p.id&&b.role==='candidate_diff'));
  if(matches.length>1)throw Error('More than one Review pane is bound; select the desired existing pane.');
  let target=matches[0],revision=current.revision;
  if(!target){
    const name=`Candidate Review · ${project.name}`;
    // Reconnect a uniquely named, unbound pane left by an interrupted binding.
    const orphan=panes.filter(p=>p.kind==='browser'&&p.url===REVIEW_URL&&!listed.bindings.some((b:Data)=>b.pane_id===p.id)&&current.state.monitors.some((m:Data)=>m.id===p.window_id&&m.name===name));
    if(orphan.length>1)throw Error('Multiple unbound Review panes require an explicit binding choice.');
    target=orphan[0];
    if(!target){
      const previous=new Set(current.state.monitors.map((m:Data)=>m.id));
      const created=await workspace({action:'apply',base_revision:revision,operations:[{action:'add_window',kind:'browser',name,url:REVIEW_URL}],intent:'Open one trusted candidate Review view'});
      const added=created.state.monitors.filter((m:Data)=>!previous.has(m.id));
      if(added.length!==1||added[0].layout.type!=='pane')throw Error('Review creation outcome requires workspace inspection.');
      target={...added[0].layout.pane,window_id:added[0].id};revision=created.revision;
    }
    await api({action:'bind',project_id:projectId,resource_id:resource.id,pane_id:target.id,base_revision:revision,role:'candidate_diff'});
  }else await workspace({action:'apply',base_revision:revision,operations:[{action:'select',window_id:target.window_id}],intent:'Select the existing candidate Review view'});
  window.dispatchEvent(new Event('orbit-workbench-review-bound'));
}
