import { el, button } from './dom';
export function showBuildQueue(api:(body:Record<string,unknown>)=>Promise<any>){
 const dialog=el('dialog','hermes-tools-dialog');dialog.setAttribute('aria-label','Automated build queue');dialog.style.background='#251b38';
 const status=el('p','','Loading saved tasks…'),list=el('div'),input=el('textarea');input.placeholder='Describe one task and how to verify it';input.setAttribute('aria-label','Build task');input.maxLength=8000;
 let revision=0,timer:ReturnType<typeof setTimeout>|undefined,working=false;
 async function request(operation:string,extra:Record<string,unknown>={}){return api({action:'build_queue',operation,base_revision:revision,...extra});}
 async function change(operation:string,extra:Record<string,unknown>={}){if(working)return;working=true;try{draw(await request(operation,extra));}catch(e){status.textContent=String(e);}finally{working=false;}}
 function draw(data:any){revision=data.revision;status.textContent=data.enabled?'Queue running · one task at a time':'Queue paused · saved on server';list.replaceChildren();
  for(const t of data.tasks){const card=el('section','hermes-job');card.append(el('h3','',t.input),el('p','',`${t.status} · ${t.note}`));
   if(t.run)card.append(el('small','',`Run: ${t.run}`));
   if(t.output){const details=el('details'),output=el('pre','',t.output);output.style.whiteSpace='pre-wrap';details.append(el('summary','','Result / evidence'),output);card.append(details);}
   if(t.status==='waiting_for_approval')card.append(button('Review approval','Review build task approval',async()=>{
    try{const data=await request('approvals',{task_id:t.id});const review=el('dialog','hermes-tools-dialog');review.setAttribute('aria-label','Build task approval');review.append(el('h2','','Review tool approval'));
     for(const a of data.approvals)review.append(el('pre','',a.command+'\n'+a.reason));
     for(const choice of ['once','deny'])review.append(button(choice==='once'?'Allow once':'Deny',choice==='once'?'Allow build tool once':'Deny build tool',async()=>{review.close();await change('approval',{task_id:t.id,choice,confirm:true});}));
     review.append(button('Close','Close approval',()=>review.close()));review.onclose=()=>review.remove();document.body.append(review);review.showModal();
    }catch(e){status.textContent=String(e);}
   }));
   if(t.run&&!['completed','failed','cancelled','interrupted','blocked'].includes(t.status))card.append(button('Stop task','Stop build task',()=>{if(confirm('Stop this run? Completed file edits and actions will not be undone.'))void change('stop',{task_id:t.id,confirm:true});}));
   if(['queued','completed','failed','cancelled','interrupted','blocked'].includes(t.status))card.append(button('Dismiss','Dismiss build task',()=>{if(confirm('Remove this saved task? If its submission outcome is unknown, check Hermes first. This does not stop or undo any run.'))void change('dismiss',{task_id:t.id,confirm:true});}));
   list.append(card);
  }
 }
 async function refresh(){if(!dialog.open)return;if(!working){working=true;try{draw(await request('read'));}catch(e){status.textContent=String(e);}finally{working=false;}}timer=setTimeout(()=>void refresh(),4000);}
 const file=el('input');file.type='file';file.accept='application/json';file.hidden=true;
 file.onchange=async()=>{const f=file.files?.[0];if(!f)return;try{if(f.size>600000)throw Error('File too large');const d=JSON.parse(await f.text());if(d.version!==1||!Array.isArray(d.tasks))throw Error('Invalid board');const tasks=d.tasks.filter((t:any)=>t.status==='Queued');if(tasks.length>100||tasks.some((t:any)=>typeof t.title!=='string'||!t.title.trim()||t.title.length>240||typeof t.evidence!=='string'||t.evidence.length>4000))throw Error('Invalid tasks');if(!confirm(`Import ${tasks.length} queued tasks? Nothing runs until you press Start queue.`))return;if(working)throw Error('Queue updating; retry import');working=true;try{for(const t of tasks)draw(await request('add',{input:t.title+(t.evidence?'\nOwner notes: '+t.evidence:'')}));}finally{working=false;}}catch(e){status.textContent=String(e);}finally{file.value='';}};
 dialog.append(el('h2','','Automated build queue'),button('Close','Close build queue',()=>dialog.close()),el('p','','Tasks are saved privately on this server. Start authorizes their execution, one at a time, even when this panel is closed. Approvals and unverified results pause the queue. After a server restart, press Start again. Completion reflects Hermes’s report, not independent verification.'),input,button('Add task','Add build task',async()=>{if(!input.value.trim())return;await change('add',{input:input.value});}),button('Import Workshop board','Import Workshop board',()=>file.click()),file,button('Start queue','Start build queue',()=>{if(confirm('Authorize Hermes to execute the saved queued tasks? It will use real tools and may change your workspace and files. Normal tool approvals remain in effect.'))void change('start',{confirm:true});}),button('Pause queue','Pause build queue',()=>void change('pause')),el('p','','Pause prevents the next task; use Stop task to request cancellation of the active run. Stopping does not undo changes. Queue data is not part of workspace checkpoints.'),status,list);
 dialog.onclose=()=>{clearTimeout(timer);dialog.remove();};document.body.append(dialog);dialog.showModal();void refresh();
}
