import {el,button} from './dom';
export async function editAutomation(api:(b:Record<string,unknown>)=>Promise<any>,refresh:()=>Promise<void>,id?:string,duplicate=false){
 const d=el('dialog','hermes-tools-dialog');d.setAttribute('aria-label','Automation editor');const note=el('p','','Loading…');const form=el('div');d.append(el('h2','','Automation editor'),note,form,button('Close','Close automation editor',()=>{if(!form.childElementCount||window.confirm('Discard unsaved editor changes?'))d.close();}));d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
 try{
 const job=id?(await api({action:'automation',operation:'get',job_id:id})).job:{};if(!d.open)return;
 const inputs:Record<string,HTMLInputElement|HTMLTextAreaElement>={};
 for(const [key,title] of [['name','Task name'],['schedule','Schedule'],['prompt','Task prompt'],['deliver','Delivery target'],['skills','Skills (comma separated)']]){
 const label=el('label','',title);const input=key==='prompt'?el('textarea'):el('input');input.setAttribute('aria-label',title);input.value=key==='skills'?(job.skills||[]).join(', '):key==='schedule'&&typeof job.schedule==='object'?(job.schedule?.expr||job.schedule?.run_at||(job.schedule?.minutes?`every ${job.schedule.minutes}m`:job.schedule?.value)||''):String(job[key]??(key==='deliver'?'local':''));if(key==='name'&&duplicate)input.value+=' copy';inputs[key]=input;label.append(input);form.append(label);
 }
 note.textContent='Schedule is interpreted by Hermes (for example: every 1h or 0 9 * * *). Review timezone and delivery target. Saving may enable future execution; run-now may incur costs and external effects. No secrets are stored in browser storage.';
 const save=button('Save automation','Save automation',async()=>{
 const fields={name:inputs.name.value,prompt:inputs.prompt.value,schedule:inputs.schedule.value,deliver:inputs.deliver.value,skills:inputs.skills.value.split(',').map(s=>s.trim()).filter(Boolean)};
 if(!fields.name.trim()||!fields.prompt.trim()||!fields.schedule.trim()){note.textContent='Name, prompt and schedule are required.';return;}
 if(!window.confirm(`${id&&!duplicate?'Update':'Create'} task "${fields.name}" with schedule "${fields.schedule}" and delivery "${fields.deliver}"?`))return;
 save.disabled=true;try{await api({action:'automation',operation:id&&!duplicate?'update':'create',job_id:id,fields,confirm:true});d.close();await refresh();}catch(e){note.textContent=`Not confirmed: ${String(e)}. Check task list before retrying to avoid duplicates.`;}finally{save.disabled=false;}
 });form.append(save);
 }catch(e){note.textContent=String(e);}
}
