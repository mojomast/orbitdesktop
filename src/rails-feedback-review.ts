import {el,button} from './dom';
import {workspaceId} from './workspace-sync';

type Draft={target_event_id:string,idempotency_key:string,rating:number,category:string,note:string};
// An owner can transport a detached, exact-operation signature. Neither Orbit
// nor a pane asks for the independently enrolled signer's private key.
export function offerSignedReview(host:HTMLElement,draft:Draft,credential:string,current:()=>boolean,signal:AbortSignal){
  const box=el('div'),status=el('p');host.append(box);let busy=false;
  const usable=()=>current()&&box.isConnected&&!signal.aborted;
  const send=(body:object)=>fetch('/api/rizzstack/rails/feedback',{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},
    credentials:'omit',redirect:'error',cache:'no-store',signal,body:JSON.stringify(body)});
  const prepare=button('Prepare signed feedback','Prepare signed feedback',async()=>{
    if(busy||!usable())return;busy=true;prepare.disabled=true;
    try{
      const r=await send({action:'preview',draft:{workspace_id:workspaceId,target_event_id:draft.target_event_id,
        idempotency_key:draft.idempotency_key,rating:draft.rating,category:'quality',note:draft.note}});
      const p=await r.json();if(!usable())return;
      if(!r.ok||p.ok!==true||typeof p.review!=='string'){status.textContent=p.error?.code==='capability_unavailable'?'No enrolled feedback writer available.':'Coordinator refused this preview.';return;}
      const text=p.review;const exact=el('pre','',text);const download=button('Save review','Save exact review bytes',()=>{
        const a=el('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/plain'}));a.download='rails-feedback-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
      const sig=el('textarea');sig.setAttribute('aria-label','Detached SSH signature');sig.maxLength=2048;sig.autocomplete='off';sig.spellcheck=false;
      const confirm=button('Confirm signed feedback','Confirm signed feedback',async()=>{
        if(busy||!usable()||!sig.value)return;busy=true;confirm.disabled=true;sig.readOnly=true;
        try{
          const resp=await send({action:'confirm',review:text,signature:sig.value.trim()+'\n'});const receipt=await resp.json();if(!usable())return;
          if(resp.ok&&receipt.ok&&typeof receipt.event_id==='string'){
            status.textContent=`Feedback recorded: ${receipt.event_id}${receipt.duplicated?' (original receipt)':''}`;sig.value='';return;
          }
          if(resp.status>=500)throw Error();
          status.textContent='Feedback refused. Check the workspace, signature, expiry and enrolled owner.';confirm.disabled=false;sig.readOnly=false;
        }catch{if(usable()){status.textContent='Outcome unknown. Reconfirm only this same signed review to recover the receipt.';confirm.disabled=false;}}
        finally{busy=false;}
      });
      box.replaceChildren(el('p','','Review the exact document, sign it independently, then confirm. This records a quality annotation only.'),exact,download,sig,confirm,status);
    }catch{if(usable())status.textContent='Coordinator unavailable. No confirmation was submitted.';}
    finally{busy=false;if(usable())prepare.disabled=false;}
  });
  box.append(prepare,status);
}
