import { el, button } from './dom';
import './agent-activity.css';
import { requestOpenHostSurface } from './host-surfaces';
type Entry = {title:string; task:string; status:string; updated:number; focus:()=>void};
const agents = new Map<string,Entry>();
const listeners = new Set<()=>void>();
export function registerActivity(id:string, focus:()=>void) {
  const entry:Entry = {title:'Hermes',task:'No task yet',status:'Ready',updated:Date.now(),focus};
  agents.set(id,entry);
  const notify = () => listeners.forEach(fn=>fn());
  notify();
  return { update(patch:Partial<Omit<Entry,'focus'>>) { Object.assign(entry,patch,{updated:Date.now()}); notify(); }, dispose() { if(agents.get(id)===entry) agents.delete(id); notify(); } };
}
export function mountAgentOverview(host:HTMLElement, beforeFocus:()=>void=()=>{}) {
  const root=el('section','agent-overview-view');
  const list=el('div','agent-overview-list');
  root.append(el('h2','','Workspace agents'),el('p','','Live status for agent panes in this desktop. Task text is your latest request, not an inferred plan.'),list);host.append(root);
  let disposed=false;
  function render() {
    if(disposed)return;
    const active=root.contains(document.activeElement)?document.activeElement as HTMLElement:null;
    const focused=active?.dataset.agentId;
    list.replaceChildren();
    for(const [id,a] of agents) {
      const row=button('','Focus this agent pane',()=>{beforeFocus();a.focus();},'agent-overview-row');
      row.dataset.agentId=id;
      row.append(el('strong','',a.title),el('span','',a.status),el('small','',a.task));
      const group=el('article','agent-overview-group');group.append(row);
      list.append(group);
      if(focused===id)row.focus();
    }
    if(!agents.size) list.append(el('p','','No agent panes are open.'));
  }
  listeners.add(render);render();
  return ()=>{if(disposed)return;disposed=true;listeners.delete(render);root.remove();};
}
export function openAgentOverview() {
  const existing = document.querySelector<HTMLDialogElement>('.agent-overview');
  if(existing) {existing.focus();return;}
  const dialog=el('dialog','agent-overview');
  dialog.setAttribute('aria-label','Workspace agent overview');
  dialog.append(button('Close','Close overview',()=>dialog.close()),button('Open as window','Open Workspace Activity as window',()=>{requestOpenHostSurface('activity');dialog.close();}));
  const dispose=mountAgentOverview(dialog,()=>dialog.close());
  dialog.addEventListener('close',()=>{dispose();dialog.remove();},{once:true});
  document.body.append(dialog);dialog.showModal();
}
