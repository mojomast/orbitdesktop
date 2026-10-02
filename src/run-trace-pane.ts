import './run-trace-pane.css';
import {createRunTraceClient,type RunTrace,type TraceSpan} from './run-trace-client';
import {requestConversationContext} from './conversation-transfer';
import {traceDiagnosticSummary} from './run-trace-summary';

export function mountRunTracePane(host:HTMLElement,token:()=>string,_options?:{paneId?:string}):{dispose():void}{
  const client=createRunTraceClient(token);let disposed=false,busy=false,selected='',spans=new Map<string,TraceSpan>(),cursor=0,generation=0;
  const root=document.createElement('section');root.className='run-trace-pane';host.replaceChildren(root);
  const title=document.createElement('h2');title.textContent='Run traces';
  const note=document.createElement('p');note.textContent='Private, derived observations. Missing events and partial lifecycles do not establish execution outcomes.';
  const controls=document.createElement('div');controls.className='run-trace-controls';
  const select=(label:string,values:string[])=>{const wrapper=document.createElement('label');wrapper.append(`${label} `);const input=document.createElement('select');input.setAttribute('aria-label',label);for(const value of values){const option=document.createElement('option');option.value=value==='All'?'':value;option.textContent=value;input.append(option);}wrapper.append(input);controls.append(wrapper);return input;};
  const method=select('Method',['All','normal','workbench']);const status=select('Run status',['All','running','completed','failed','partial']);
  const category=select('Span category',['All','agent','tools','checks','files','evidence','warnings']);
  const runPicker=select('Run',['All']);runPicker.firstElementChild!.textContent='Select a run';
  const message=document.createElement('p');message.role='status';
  const toolbar=document.createElement('div');toolbar.className='run-trace-controls';
  const button=(label:string,action:()=>void)=>{const b=document.createElement('button');b.textContent=label;b.type='button';b.addEventListener('click',action);toolbar.append(b);return b;};
  const rows=document.createElement('div');rows.className='run-trace-waterfall';
  const details=document.createElement('pre');details.className='run-trace-detail';
  root.append(title,note,controls,toolbar,message,rows,details);
  const report=(error:unknown)=>{if(!disposed)message.textContent=error instanceof Error?error.message:String(error);};
  function render(){
    const all=[...spans.values()].sort((a,b)=>a.start_unix_ms-b.start_unix_ms||a.sequence-b.sequence);
    const min=Math.min(...all.map(s=>s.start_unix_ms)),max=Math.max(...all.map(s=>s.end_unix_ms??s.start_unix_ms)),width=Math.max(1,max-min);
    const fragment=document.createDocumentFragment();
    for(const span of all.filter(s=>!category.value||s.category===category.value).slice(0,500)){
      const row=document.createElement('button');row.type='button';row.className=`run-trace-row ${span.status}`;row.dataset.spanId=span.span_id;
      const text=document.createElement('span');text.textContent=`${span.parent_span_id?'↳ ':''}${span.name}`;
      const track=document.createElement('span');track.className='run-trace-track';const bar=document.createElement('span');bar.className=span.duration_origin==='instant'?'run-trace-instant':'run-trace-bar';bar.style.left=`${100*(span.start_unix_ms-min)/width}%`;bar.style.width=`${Math.max(.5,100*((span.end_unix_ms??span.start_unix_ms)-span.start_unix_ms)/width)}%`;track.append(bar);
      const duration=document.createElement('span');duration.textContent=span.end_unix_ms===null?'open':span.duration_origin==='instant'?'instant':`${Math.round(span.end_unix_ms-span.start_unix_ms)} ms`;
      row.append(text,track,duration);row.title=`${span.status} · ${span.duration_origin} · ${span.span_id}`;
      row.addEventListener('click',()=>{details.textContent=`${span.name}\n${span.span_id}\nTiming: ${span.duration_origin}\nAuthority: ${span.authority}\n${span.attributes.map(a=>`${a.key}: ${a.value}`).join('\n')}`;for(const ref of span.references){const line=document.createElement('p');line.textContent=`Authoritative ${ref.kind} record: `;const copy=document.createElement('button');copy.textContent=ref.id;copy.title='Copy authoritative opaque record ID';copy.onclick=()=>{void navigator.clipboard.writeText(ref.id).catch(report);};line.append(copy);details.append(line);}});
      fragment.append(row);
    }
    rows.replaceChildren(fragment);
  }
  async function refresh(){
    if(disposed||busy)return;busy=true;const version=generation;
    try{
      const result=await client.request<{traces:RunTrace[]}>('list',{...(method.value?{method:method.value}:{}),...(status.value?{status:status.value}:{})});
      if(disposed||version!==generation)return;
      runPicker.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent='Select a run';runPicker.append(blank);
      for(const run of result.traces){const option=document.createElement('option');option.value=run.trace_id;option.textContent=`${run.method} · ${run.status}${run.partial?' (gaps)':''} · ${run.run_id}`;runPicker.append(option);}
      if(selected&&!result.traces.some(r=>r.trace_id===selected)){selected='';spans.clear();cursor=0;render();}
      runPicker.value=selected;
      if(selected){const data=await client.request<{spans:TraceSpan[];after_sequence:number;has_more:boolean;partial:boolean;status:string}>('page',{trace_id:selected,after_sequence:cursor,limit:500});if(disposed||version!==generation)return;for(const span of data.spans)spans.set(span.span_id,span);cursor=data.after_sequence;render();message.textContent=`${data.status}${data.partial?' · observation gaps':''} · ${spans.size} observed spans${data.has_more?' · more pages loading':''}. Open spans have no confirmed end; local_observation is server observation timing.`;}
      else message.textContent=result.traces.length?'Select a run to inspect its waterfall.':'No locally observed traces yet.';
    }catch(error){report(error);}finally{busy=false;}
  }
  button('Refresh',()=>{void refresh();});
  button('First failure',()=>{const first=[...spans.values()].find(s=>s.status==='error');if(first)rows.querySelector<HTMLElement>(`[data-span-id="${first.span_id}"]`)?.focus();});
  button('Share diagnostic summary',()=>{void (async()=>{
    if(!selected){message.textContent='Select a run before sharing diagnostics.';return;}
    const id=selected,version=generation;
    // Read a fresh bounded snapshot rather than treating a stale waterfall as a
    // complete trace. The owner reviews this captured snapshot before insertion.
    const listing=await client.request<{traces:RunTrace[]}>('list');
    const trace=listing.traces.find(value=>value.trace_id===id);
    if(!trace)throw Error('This trace is no longer available. Refresh the list.');
    const page=await client.request<{spans:TraceSpan[];has_more:boolean;partial:boolean;status:string}>('page',{trace_id:id,after_sequence:0,limit:500});
    if(disposed||version!==generation||id!==selected)return;
    const outcome=await requestConversationContext({title:'Run diagnostic snapshot',source:'Private derived timing metadata',text:traceDiagnosticSummary({...trace,status:page.status,partial:page.partial},page.spans,page.has_more)});
    if(!disposed&&version===generation)message.textContent=outcome.status==='delivered'?'Diagnostic snapshot inserted into the selected draft; no message was sent.':`Diagnostic sharing: ${outcome.status}.`;
  })().catch(report);});
  button('Export JSON',()=>{if(!selected)return;void client.request<{resource_spans:unknown;filename:string}>('export',{trace_id:selected}).then(data=>{if(disposed)return;const url=URL.createObjectURL(new Blob([JSON.stringify(data.resource_spans,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=data.filename;link.click();URL.revokeObjectURL(url);}).catch(report);});
  button('Remove trace',()=>{if(!selected||!confirm('Remove this derived local trace?'))return;void client.request('remove',{trace_id:selected}).then(()=>{selected='';cursor=0;spans.clear();generation++;render();void refresh();}).catch(report);});
  button('Retention preview',()=>{void client.request<{eligible:number}>('retention',{dry_run:true}).then(data=>{if(!disposed)message.textContent=`${data.eligible} traces older than seven days eligible for removal.`;}).catch(report);});
  button('Apply retention',()=>{void client.request<{removed:number}>('retention',{dry_run:false}).then(data=>{if(!disposed)message.textContent=`Removed ${data.removed} expired traces.`;}).catch(report);});
  runPicker.onchange=()=>{selected=runPicker.value;cursor=0;spans.clear();generation++;details.replaceChildren();render();void refresh();};
  for(const filter of [method,status])filter.onchange=()=>{generation++;void refresh();};category.onchange=render;
  const timer=setInterval(()=>{void refresh();},2000);void refresh();
  return {dispose(){disposed=true;clearInterval(timer);client.dispose();root.remove();}};
}
