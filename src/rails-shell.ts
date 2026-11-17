// Reviewed Orbit shell only. Catalog apps can request navigation; they never
// receive a callback, credential, query result or mutation capability.
import {el,button} from './dom';
import {offerSignedReview} from './rails-feedback-review';
// Reuse the release-owned static validator/preview policy on demand. Neither
// the main renderer build nor a catalog bundle supplies privileged code here.
const moduleAt=(name:'rails.js'|'feedback.js')=>import(/* @vite-ignore */ (location.origin+'/rails-pane/'+name));

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const kinds=['attempt','job','campaign','session','event'];
type Selector={kind:string,id:string};
type View={integrity:{status:string},completeness:string,lanes:{marks:{event_id:string}[]}[]};
const goodSelector=(s:Selector)=>kinds.includes(s.kind)&&typeof s.id==='string'&&ID.test(s.id);
let dismiss:(()=>void)|undefined;

export function bindRailsNavigation(frame:HTMLIFrameElement, url:URL, token:()=>string) {
  const app=/^\/apps\/rizzstack-(observatory|rails)(?:-[0-9a-f]{24})?\/(?:index\.html)?$/.exec(url.pathname)?.[1];
  if(!app||url.origin!==location.origin)return ()=>{};
  let close:(()=>void)|undefined;
  const receive=(event:MessageEvent)=>{
    if(!frame.isConnected||event.source!==frame.contentWindow||event.origin!=='null'||event.data?.type!=='orbit-open-rails'||
      dismiss)return;
    // The catalog Rails launcher may open an empty chooser. Observatory may
    // preselect an ID, but cannot initiate an authenticated read.
    let selector:Selector|undefined;
    if(app==='observatory'){
      if(!['attempt','job'].includes(event.data.kind)||!goodSelector(event.data))return;
      selector={kind:event.data.kind,id:event.data.id};
    }
    close=openRailsShell(token,selector,()=>{
      close=undefined;frame.focus();frame.contentWindow?.postMessage({type:'orbit-rails-closed'},'*');
    });
  };
  window.addEventListener('message',receive);
  return ()=>{window.removeEventListener('message',receive);close?.();};
}

async function consumeStream(response:Response, onFrame:(frame:string)=>Promise<void>) {
  if(!response.body||!response.headers.get('Content-Type')?.startsWith('text/event-stream'))throw Error();
  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();let text='';
  try {while(true){const part=await reader.read();if(part.done)break;
    text=(text+part.value).replace(/\r\n/g,'\n');if(text.length>1024*1024)throw Error();
    let end;while((end=text.indexOf('\n\n'))!==-1){const frame=text.slice(0,end);text=text.slice(end+2);await onFrame(frame);}
  }}finally{await reader.cancel().catch(()=>{});}
}

export function openRailsShell(token:()=>string, initial?:Selector, onClose=()=>{}) {
  dismiss?.();
  const dialog=el('dialog');dialog.setAttribute('aria-label','Rizzstack Rails');dialog.style.cssText='width:min(92vw,1100px);max-height:90vh;overflow:auto;color-scheme:dark';
  const kind=el('select');kind.setAttribute('aria-label','Selector kind');
  for(const name of kinds)kind.add(new Option(name,name));kind.value=initial?.kind||'attempt';
  const input=el('input');input.setAttribute('aria-label','Public selector ID');input.placeholder='Public selector ID';input.maxLength=192;input.value=initial?.id||'';
  const status=el('p','','Choose a selector and inspect its bounded history.');status.setAttribute('role','status');
  const live=el('small'), health=el('small'), selection=el('p');
  const iframe=el('iframe');iframe.title='Read-only Rails timeline';iframe.sandbox.add('allow-scripts');iframe.referrerPolicy='no-referrer';iframe.style.cssText='width:100%;height:44vh';
  const inspect=button('Inspect','Inspect history',()=>start());
  const more=button('Next page','Read next page',()=>{if(query&&nextCursor)void load(query,nextCursor);});more.disabled=true;
  const reset=button('Latest','Return to latest page',()=>start());
  const feedback=button('Preview feedback','Preview feedback',()=>preview());feedback.disabled=true;
  const retry=button('Retry unavailable','Retry unavailable: no verified queue attachment',()=>{});retry.disabled=true;
  const previewBox=el('div');
  const close=button('Close Rails','Close Rails',()=>dialog.close());
  dialog.append(el('h2','','Rizzstack Rails'),kind,input,inspect,more,reset,close,status,health,live,iframe,selection,feedback,retry,previewBox);
  document.body.append(dialog);

  let channel:MessagePort|undefined, view:View|null=null, selected='', nextCursor='', streamCursor='', page='', disposed=false;
  type Query={controller:AbortController,selector:Selector,credential:string};
  let query:Query|undefined, pageRequest=0, pollTimer=0, reconnectTimer=0;
  const current=(q:Query)=>!disposed&&q===query&&!q.controller.signal.aborted&&q.credential===token();
  function clearSelection(){selected='';feedback.disabled=true;selection.textContent='';previewBox.replaceChildren();}
  function clearView(){view=null;channel?.postMessage({view:null});clearSelection();more.disabled=true;nextCursor='';page='';}
  function stop(){query?.controller.abort();query=undefined;clearTimeout(pollTimer);pollTimer=0;clearTimeout(reconnectTimer);live.textContent='';health.textContent='';}
  function unauthorized(){stop();clearView();status.textContent='Unauthorized. Connect the Orbit host, then inspect again.';}
  const reconnect=()=>{if(query&&!current(query))unauthorized();};window.addEventListener('orbit-host-connected',reconnect);
  const ready=(event:MessageEvent)=>{
    if(channel||event.source!==iframe.contentWindow||event.origin!=='null'||event.data?.type!=='orbit-rails-renderer-ready'||event.ports.length!==1)return;
    channel=event.ports[0];channel.onmessage=({data})=>{
      clearSelection();if(!query||!current(query)||!view||typeof data?.selected!=='string'||!view.lanes.some(l=>l.marks.some(m=>m.event_id===data.selected)))return;
      selected=data.selected;selection.textContent='Selected event: '+selected;feedback.disabled=view.integrity.status==='failed';
      void inspectMark(query,selected);
    };if(view)channel.postMessage({view});
  };
  window.addEventListener('message',ready);iframe.src='/rails-pane/index.html';
  async function preview(){
    if(!selected||!view||view.integrity.status==='failed'||!query||!current(query))return;
    const reviewing=selected;let feedbackDraft;
    try{({feedbackDraft}=await moduleAt('feedback.js'));}catch{previewBox.textContent='Preview unavailable.';return;}
    if(disposed||reviewing!==selected||!query||!current(query))return;
    const rating=el('select');rating.setAttribute('aria-label','Quality rating');for(const [val,label] of [['1','Useful'],['0','Neutral'],['-1','Needs work']])rating.add(new Option(label,val));
    const note=el('textarea');note.setAttribute('aria-label','Optional quality note');note.maxLength=2000;
    const output=el('p'),signed=el('div');const show=button('Review draft','Review sanitized draft',()=>{
      const draft=feedbackDraft(selected,Number(rating.value),'quality',note.value,null);
      output.textContent=`${draft.target_event_id} · quality ${draft.rating} · note: ${draft.note||'(none)'}. Draft only until explicitly signed and confirmed.`;
      signed.replaceChildren();const q=query;if(q&&current(q))offerSignedReview(signed,draft,q.credential,()=>current(q)&&selected===draft.target_event_id,q.controller.signal);
    });note.oninput=rating.onchange=()=>{output.textContent='';signed.replaceChildren();};
    previewBox.replaceChildren(rating,note,show,output,signed);
  }
  const request=(q:Query,route:string,params:URLSearchParams,headers:Record<string,string>={})=>fetch('/api/rizzstack/rails/'+route+(params.size?'?'+params:''),{
    method:'GET',credentials:'omit',cache:'no-store',redirect:'error',signal:q.controller.signal,headers:{Authorization:'Bearer '+q.credential,...headers}});
  async function inspectMark(q:Query,id:string){
    try{
      const r=await request(q,'events',new URLSearchParams({kind:'event',id,format:'json',limit:'1'}));
      if(!current(q)||selected!==id)return;if([401,403].includes(r.status)){unauthorized();return;}
      const result=await r.json();if(!current(q)||selected!==id)return;
      if(!r.ok||result.schema!=='rizzstack.rails-result/1'||result.items?.length!==1||result.items[0].event_id!==id)throw Error();
      const summary=[`Selected event: ${id}`];
      for(const field of ['authority','tool_name','command_family','latency','ac_id','run_id','code_rev','contract_sha256']){
        const value=result.items[0][field];if(typeof value==='string'&&ID.test(value))summary.push(`${field}: ${value}`);
      }
      selection.textContent=summary.join(' · ');
    }catch{if(current(q)&&selected===id)selection.textContent=`Selected event: ${id} · detail unavailable`;}
  }
  async function load(q:Query,after='',quiet=false){
    if(!current(q))return false;
    const sequence=++pageRequest; if(!quiet){status.textContent='Loading Rails history…';more.disabled=true;}
    const params=new URLSearchParams(q.selector);if(after)params.set('after',after);
    try {
      const r=await request(q,'view',params);if(!current(q)||sequence!==pageRequest)return false;
      if(r.status===401||r.status===403){unauthorized();return false;}
      if(!r.ok){if(r.status===404){clearView();status.textContent='No history found for this selector.';return false;}
        if(r.status===409){const code=(await r.json()).error?.code;if(!current(q)||sequence!==pageRequest)return false;
          if(code==='reset_required'&&after){clearView();return await load(q);}
          if(code==='source_fork'){clearView();status.textContent='Integrity failed. Source history cannot be trusted.';return false;}}
        throw Error();}
      const [data,{validateView}]=await Promise.all([r.json(),moduleAt('rails.js')]);if(!current(q)||sequence!==pageRequest)return false;
      if(!validateView(data).ok){clearView();status.textContent='Unsupported or invalid Rails projection.';return false;}
      // Don't remount a focused mark on heartbeats/polls with identical rows.
      const contentChanged=!view||JSON.stringify({...data,generated_at:null})!==JSON.stringify({...view,generated_at:null});
      view=data;page=after;nextCursor=r.headers.get('x-rails-next-cursor')||'';more.disabled=!nextCursor;
      if(!after)streamCursor=r.headers.get('x-rails-stream-cursor')||'';
      if(contentChanged){if(!selected||data.integrity.status==='failed'||!view?.lanes.some(l=>l.marks.some(m=>m.event_id===selected)))clearSelection();channel?.postMessage({view});}
      status.textContent=(data.integrity.status==='failed'?'Integrity failed. ': '')+`${q.selector.kind} ${q.selector.id} · ${data.completeness} history`+
        (r.headers.get('x-rails-truncated')==='true'?' · truncated':'')+(nextCursor?' · more pages':'');
      return true;
    }catch{if(current(q)&&sequence===pageRequest)status.textContent=view?'Disconnected — showing the last snapshot.':'Disconnected — Rails source unavailable.';return false;}
  }
  const schedulePoll=(q:Query)=>{clearTimeout(pollTimer);pollTimer=window.setTimeout(async()=>{
    if(!current(q))return;if(!page)await load(q,'',true);if(current(q))schedulePoll(q);
  },document.hidden?30000:5000);};
  async function follow(q:Query,delay=1000){
    if(!current(q))return;
    try {
      const r=await request(q,'stream',new URLSearchParams(q.selector),streamCursor?{'Last-Event-ID':streamCursor}:{});
      if(!current(q))return;
      if([401,403].includes(r.status)){unauthorized();return;}
      if(r.status===409){streamCursor='';await load(q);}
      else if(r.ok){
        clearTimeout(pollTimer);pollTimer=0;live.textContent=' · Connected to updates';
        await consumeStream(r,async frame=>{
          if(!current(q))return;
          if(/^event: *invalidate$/m.test(frame)){
            if(page)live.textContent=' · New history available — choose Latest';
            else if(!await load(q,'',true))throw Error();
          }
          const cursor=/^id: *([A-Za-z0-9._~:=+-]{1,1024})$/m.exec(frame)?.[1];if(cursor)streamCursor=cursor;
          delay=1000;
        });
      }
    }catch{/* A bounded snapshot remains visible during reconnect. */}
    if(current(q)){live.textContent=' · Stream disconnected; polling';if(!pollTimer)schedulePoll(q);
      reconnectTimer=window.setTimeout(()=>void follow(q,Math.min(30000,delay*2)),Math.min(30000,delay*(1+Math.random()/4)));}
  }
  function start(){
    stop();clearView();streamCursor='';
    const selector={kind:kind.value,id:input.value.trim()}, credential=token();if(!credential){unauthorized();return;}
    if(!goodSelector(selector)){status.textContent='Enter a valid public selector ID.';return;}
    const q=query={selector,credential,controller:new AbortController()};
    void request(q,'health',new URLSearchParams()).then(async r=>{
      if(!current(q))return;if([401,403].includes(r.status)){unauthorized();return;}
      health.textContent=r.ok?'Read service reachable':'Read service unavailable';
    }).catch(()=>{if(current(q))health.textContent='Read service disconnected';});
    void load(q).then(()=>{if(current(q))void follow(q);});
  }
  const visibility=()=>{if(query&&current(query)&&!page&&!document.hidden)void load(query,'',true);};
  document.addEventListener('visibilitychange',visibility);
  const dispose=()=>{if(disposed)return;disposed=true;stop();channel?.close();window.removeEventListener('message',ready);window.removeEventListener('orbit-host-connected',reconnect);
    document.removeEventListener('visibilitychange',visibility);dialog.remove();dismiss=undefined;onClose();};
  dialog.addEventListener('close',dispose,{once:true});dismiss=dispose;dialog.showModal();
  if(!token())unauthorized();else if(initial)inspect.focus();else input.focus();return dispose;
}
