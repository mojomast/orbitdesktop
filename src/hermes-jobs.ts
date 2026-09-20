import { editAutomation } from './automation-editor';
import { el, button } from './dom';
export function showHermesJobs(api: (body: Record<string, unknown>) => Promise<any>) {
 const dialog = el('dialog', 'hermes-tools-dialog'); dialog.setAttribute('aria-label', 'Hermes scheduled tasks');
 const status = el('p', '', 'Loading from Hermes…'); const list = el('div', 'hermes-job-list');
 const search = el('input'); search.placeholder = 'Filter tasks'; search.setAttribute('aria-label', 'Filter Hermes tasks');
 let jobs: Record<string, any>[] = []; let timer: ReturnType<typeof setTimeout> | undefined; let loading = false;
 function draw() {
  list.replaceChildren();
  for (const job of jobs.filter(j => `${j.name} ${j.id}`.toLowerCase().includes(search.value.toLowerCase()))) {
   const card = el('section', 'hermes-job');card.append(el('h3', '', String(job.name || job.id || 'Unnamed task')));
   for (const [key,label] of [['id','ID'],['enabled','Enabled'],['paused','Paused'],['state','State'],['schedule_display','Schedule'],['schedule','Schedule definition'],['next_run_at','Next run'],['last_run_at','Last run'],['last_status','Last result']]) {
    if(job[key] !== undefined) card.append(el('p', '', `${label}: ${job[key]}`));
   }
   for (const operation of ['pause', 'resume']) card.append(button(operation === 'pause' ? 'Pause' : 'Resume', `${operation} task ${job.name || job.id}`, () => {
    const confirm = el('dialog', 'hermes-tools-dialog'); confirm.setAttribute('aria-label', 'Confirm schedule change');
    const note = el('p', '', `${operation === 'pause' ? 'Pause future executions of' : 'Resume scheduling for'} ${job.name || job.id}? This changes the actual Hermes schedule. Pausing does not stop an already-running task.`);
    const commit = button('Confirm', 'Confirm schedule change', async () => {
     commit.disabled = true; cancel.disabled = true;
     try { await api({action:'job_control',job_id:job.id,operation,confirm:true}); confirm.close(); await refresh(); }
     catch(error) { note.textContent = `Change not confirmed: ${error instanceof Error ? error.message : 'Connection error'}. Refresh task state before retrying.`; }
     finally { commit.disabled=false;cancel.disabled=false; }
    });
    const cancel = button('Cancel', 'Cancel schedule change', () => confirm.close());
    confirm.append(note,cancel,commit);confirm.addEventListener('close',()=>confirm.remove());document.body.append(confirm);confirm.showModal();
   }));
   card.append(button('Edit',`Edit task ${job.name||job.id}`,()=>{void editAutomation(api,refresh,job.id);}),button('Duplicate',`Duplicate task ${job.name||job.id}`,()=>{void editAutomation(api,refresh,job.id,true);}));
   for(const operation of ['run','delete'])card.append(button(operation==='run'?'Run now':'Delete',`${operation} task ${job.name||job.id}`,async()=>{if(!window.confirm(operation==='run'?`Run ${job.name||job.id} now? May incur costs and external effects.`:`Permanently delete ${job.name||job.id}? Workspace checkpoints cannot restore this task.`))return;try{await api({action:'automation',operation,job_id:job.id,confirm:true});await refresh();}catch(e){status.textContent=`Action not confirmed: ${String(e)}. Check state before retrying.`;}}));
   list.append(card);
  }
  if (!list.childElementCount) list.append(el('p', '', jobs.length ? 'No matching tasks.' : 'Hermes returned no scheduled tasks.'));
 }
 async function refresh() {
  if(loading || !dialog.open) return; loading=true;clearTimeout(timer);
  try {const data=await api({action:'jobs'}); if(!dialog.open)return;jobs=data.jobs;draw();status.textContent=`${jobs.length} scheduled tasks · Updated ${new Date().toLocaleTimeString()}`;}
  catch(error){status.textContent=`Could not refresh: ${error instanceof Error ? error.message : 'Connection error'}. Previously displayed data may be stale.`;}
  finally{loading=false;if(dialog.open)timer=setTimeout(()=>{void refresh();},15000);}
 }
 search.addEventListener('input',draw);
 dialog.append(el('h2','','Hermes scheduled tasks'),button('Close','Close scheduled tasks',()=>dialog.close()),el('p','','Live tasks for this Hermes profile. Pause/resume changes require confirmation. Tasks execute on the gateway independently of Orbit. Times are shown as returned by Hermes. Up to 200 tasks; prompts and delivery details are loaded only when you open Edit or Duplicate.'),search,button('Refresh','Refresh scheduled tasks',()=>{void refresh();}),status,list);
 dialog.prepend(button('New automation','New automation',()=>{void editAutomation(api,refresh);}));
 dialog.addEventListener('close',()=>{clearTimeout(timer);dialog.remove();});document.body.append(dialog);dialog.showModal();void refresh();
}
