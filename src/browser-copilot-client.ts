import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';

export function createBrowserCopilotClient(getToken:()=>string, options?:{workspaceId?:string;signal?:AbortSignal;isCurrent?:()=>boolean}) {
  const workspace=options?.workspaceId||workspaceId;
  return async (action:string,fields:Record<string,unknown>={})=>{
    const credential=getToken();
    const signal=AbortSignal.any([...(options?.signal?[options.signal]:[]),AbortSignal.timeout(15000)]);
    const current=()=>{if(options?.isCurrent?.()===false||getToken()!==credential)throw Object.assign(Error('Host binding changed during request.'),{code:'stale_binding'});if(signal.aborted)throw signal.reason;};
    current();if(!credential)throw Error('Connect host to enable workspace control.');
    if(!options?.workspaceId)await new Promise<void>((resolve,reject)=>{
      const interrupted=()=>reject(signal.reason);signal.addEventListener('abort',interrupted,{once:true});
      if(signal.aborted){interrupted();return;}
      ensureWorkspaceSynced().then(resolve,reject).finally(()=>signal.removeEventListener('abort',interrupted));
    });
    current();
    const response=await fetch('/api/browser-copilot',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${credential}`},body:JSON.stringify({...fields,action,workspace_id:workspace}),signal,cache:'no-store'});
    const data=await response.json();current();if(!response.ok||!data.ok)throw Error(data.code||'Browser request failed');return data;
  };
}
