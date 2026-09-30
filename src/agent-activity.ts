import { el, button } from './dom';
import './agent-activity.css';
type Entry = {title:string; task:string; status:string; updated:number; focus:()=>void;
  mode?:'normal'|'workbench'; normalStatus?:string; workbenchStatus?:string;
  focusMode?:(mode:'normal'|'workbench')=>void; modesAvailable?:()=>boolean};
const agents = new Map<string,Entry>();
const listeners = new Set<()=>void>();
export function registerActivity(id:string, focus:()=>void, options:{focusMode?:(mode:'normal'|'workbench')=>void; modesAvailable?:()=>boolean}={}) {
  const entry:Entry = {title:'Hermes',task:'No task yet',status:'Ready',updated:Date.now(),focus,...options};
  agents.set(id,entry);
  const notify = () => listeners.forEach(fn=>fn());
  notify();
  return { update(patch:Partial<Omit<Entry,'focus'|'focusMode'>>) { Object.assign(entry,patch,{updated:Date.now()}); notify(); }, dispose() { if(agents.get(id)===entry) agents.delete(id); notify(); } };
}
export function openAgentOverview() {
  const existing = document.querySelector<HTMLDialogElement>('.agent-overview');
  if(existing) {existing.focus();return;}
  const dialog=el('dialog','agent-overview');
  dialog.setAttribute('aria-label','Workspace agent overview');
  const list=el('div','agent-overview-list');
  dialog.append(el('h2','','Workspace agents'),el('p','','Live status for agent panes in this desktop. Task text is your latest request, not an inferred plan.'),button('Close','Close overview',()=>dialog.close()),list);
  function render() {
    const focused = (document.activeElement as HTMLElement)?.dataset.agentId,focusedMode=(document.activeElement as HTMLElement)?.dataset.agentMode;
    list.replaceChildren();
    for(const [id,a] of agents) {
      const row=button('','Focus this agent pane',()=>{dialog.close();a.focus();},'agent-overview-row');
      row.dataset.agentId=id;
      row.append(el('strong','',a.title),el('span','',a.status),el('small','',a.task));
      const group=el('article','agent-overview-group');group.append(row);
      if(a.focusMode){
        const modes=el('div','agent-overview-modes');
        for(const mode of ['normal','workbench'] as const){
          if(mode==='workbench' && a.modesAvailable && !a.modesAvailable()) continue;
          const status=mode==='normal'?(a.normalStatus??a.status):(a.workbenchStatus??'No supervised task');
          const control=button(`${mode==='normal'?'Normal':'Workbench'} · ${status}`,`Focus ${mode} mode in ${a.title}`,()=>{dialog.close();a.focus();a.focusMode?.(mode);});
          control.dataset.agentId=id;control.dataset.agentMode=mode;control.setAttribute('aria-pressed',String(a.mode===mode));modes.append(control);
        }
        group.append(modes);
      }
      list.append(group);
      if(focused===id){const target=focusedMode?group.querySelector<HTMLElement>(`[data-agent-mode="${focusedMode==='workbench'?'workbench':'normal'}"]`):row;target?.focus();}
    }
    if(!agents.size) list.append(el('p','','No agent panes are open.'));
  }
  listeners.add(render);render();
  dialog.addEventListener('close',()=>{listeners.delete(render);dialog.remove();});
  document.body.append(dialog);dialog.showModal();
}
