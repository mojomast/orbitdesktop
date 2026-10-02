import './saved-workspace-layouts.css';
import {el,button} from './dom';
import {workspaceFetch} from './workspace-client';
import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';
import {measuredViewport, type ArrangeViewport} from './workspace-arrange-plan';
import {type SavedLayout} from './saved-workspace-layouts-plan';
import {parsePendingSavedLayout,retainSavedLayout,savedLayoutPendingKey,type PendingSavedLayout} from './saved-workspace-layouts-pending';
import type {Workspace} from './model';
import {clearRetainedCommand,clearRetainedEnvelope,retainedCommandMatches} from './saved-workspace-layouts-retention';

interface Preview {base_revision:number;layout:SavedLayout;viewport:ArrangeViewport;state:Workspace;missing:string[];name:string;}
/** Host-owned, owner-authenticated layout metadata dialog. */
export function showSavedWorkspaceLayouts(token:()=>string,viewport:()=>{width:number;height:number}) {
  const existing=document.querySelector<HTMLDialogElement>('dialog.saved-workspace-layouts');if(existing){existing.focus();return;}
  const dialog=el('dialog','saved-workspace-layouts');dialog.setAttribute('aria-label','Saved workspace layouts');
  const status=el('p','saved-layout-status');status.setAttribute('role','status');
  const list=el('div','saved-layout-list'),summary=el('div','saved-layout-summary'),drawing=el('div','saved-layout-drawing');
  drawing.setAttribute('aria-label','Read-only saved layout geometry preview');
  const name=el('input');name.maxLength=80;name.placeholder='Layout name';name.setAttribute('aria-label','Layout name');
  const picker=el('select');picker.setAttribute('aria-label','Saved layout');
  const mappings=el('div','saved-layout-mappings');let replacements:Record<string,string>={};
  let preview:Preview|undefined,pending:PendingSavedLayout|undefined,busy=false,unresolved=false,blocked=false,closed=false;
  const key=savedLayoutPendingKey(workspaceId);
  try{const raw=sessionStorage.getItem(key);if(raw!==null){unresolved=true;pending=parsePendingSavedLayout(raw,workspaceId);}}catch{unresolved=true;blocked=true;}
  function controls(){for(const control of [save,rename,remove,stage,picker,name])control.disabled=busy||unresolved;apply.disabled=busy||blocked||(!pending&&(!preview||preview.missing.length>0));apply.textContent=unresolved?'Retry exact apply':'Apply preview';refresh.disabled=busy;discard.hidden=!unresolved;discard.disabled=busy;}
  function invalidate(message?:string){preview=undefined;summary.replaceChildren();drawing.replaceChildren();if(message)status.textContent=message;controls();}
  async function api(body:Record<string,unknown>,endpoint='/api/workspace-layouts') {
    const response=await workspaceFetch(token(),{workspace_id:workspaceId,...body},endpoint);const data=await response.json();if(!response.ok)throw Error(data.error??'Layout request failed');return data;
  }
  async function current(){await ensureWorkspaceSynced();return api({action:'read'},'/api/workspace');}
  async function run(task:()=>Promise<void>){if(busy)return;busy=true;controls();try{await task();}catch(error){if(!closed)status.textContent=unresolved?`Unresolved apply: ${String(error)}. Exact retained command can be retried after reopen/reload; close or Escape is available.`:String(error);}finally{busy=false;if(!closed)controls();}}
  async function load(){const result=await api({action:'list'});if(closed)return;const selected=picker.value;picker.replaceChildren();for(const item of result.layouts){const option=el('option','',`${item.name} · ${item.window_count} windows`);option.value=item.id;picker.append(option);}if(Array.from(picker.options).some(o=>o.value===selected))picker.value=selected;
    status.textContent=unresolved?`Unresolved exact apply ${pending?.operation_id??'(unreadable)'}. Retry is retained across reopen/reload. Close or Escape is available. Read state before explicitly discarding.`:`${result.layouts.length} saved layouts · workspace revision ${result.revision}.`;
  }
  const save=button('Save current layout','Save current workspace layout',()=>void run(async()=>{const r=await current();await api({action:'capture',name:name.value,viewport:measuredViewport(viewport()),base_revision:r.revision});invalidate();await load();}));
  const rename=button('Rename','Rename saved layout',()=>void run(async()=>{await api({action:'rename',layout_id:picker.value,name:name.value});await load();}));
  const remove=button('Delete','Delete saved layout',()=>void run(async()=>{if(!confirm('Delete this saved layout definition?'))return;await api({action:'delete',layout_id:picker.value});invalidate();await load();}));
  const refresh=button('Refresh','Refresh saved layouts',()=>void run(async()=>{invalidate();await load();}));
  const stage=button('Preview','Preview saved workspace layout',()=>void run(async()=>{
    invalidate();await ensureWorkspaceSynced();const size=measuredViewport(viewport()),result=await api({action:'preview',layout_id:picker.value,viewport:size,replacements});if(closed)return;
    if(JSON.stringify(size)!==JSON.stringify(measuredViewport(viewport())))throw Error('Viewport changed; preview again');preview=result;
    summary.append(el('p','',`${result.name} · base revision ${result.base_revision} · ${size.width} × ${size.height}`),el('p','',`Existing pane identities and contents are retained. ${result.missing.length?`Missing windows: ${result.missing.join(', ')}. Choose explicit replacements below and preview again.`:'All saved window IDs matched.'}`));
    mappings.replaceChildren();for(const id of result.missing){const label=el('label','',`Missing ${result.layout.windows.find((w:{id:string})=>w.id===id)?.name??id} (${id})`),select=el('select');select.setAttribute('aria-label',`Replacement for ${id}`);const blank=el('option','','Choose current window');blank.value='';select.append(blank);
      for(const m of result.state.monitors){const option=el('option','',`${m.name} (${m.id})`);option.value=m.id;select.append(option);}select.onchange=()=>{if(select.value)replacements[id]=select.value;else delete replacements[id];invalidate('Replacement changed. Preview again.');};label.append(select);mappings.append(label);}
    drawing.style.aspectRatio=`${size.width}/${size.height}`;for(const m of result.state.monitors){if(!m.frame)continue;const tile=el('div','saved-layout-tile',m.name),f=m.frame;Object.assign(tile.style,{left:`${f.x/size.width*100}%`,top:`${f.y/size.height*100}%`,width:`${f.width/size.width*100}%`,height:`${f.height/size.height*100}%`});drawing.append(tile);}
    summary.append(el('p','',`Docking placement: ${result.placement.floats.length} floating group(s); ${result.placement.layout?'saved docked groups/splits':'default docked placement'}. Preview is metadata only.`));status.textContent='Read-only preview ready.';
  }));
  const apply=button('Apply preview','Apply saved workspace layout preview',()=>void run(async()=>{
    if(!pending){if(!preview||preview.missing.length)throw Error('Preview all matched windows first');const r=await current();if(closed)return;if(r.revision!==preview.base_revision||JSON.stringify(measuredViewport(viewport()))!==JSON.stringify(preview.viewport)){invalidate();throw Error('Workspace or viewport changed; preview again');}
      const command:PendingSavedLayout={action:'apply',workspace_id:workspaceId,operation_id:crypto.randomUUID(),intent:`Apply saved layout: ${preview.name}`.slice(0,160),base_revision:preview.base_revision,layout:preview.layout,viewport:preview.viewport,replacements:{...replacements}};
      retainSavedLayout(sessionStorage,command);pending=command;unresolved=true;
    }
    const command=structuredClone(pending!);
    try{const result=await api(command as unknown as Record<string,unknown>);if(!clearRetainedCommand(sessionStorage,key,command))throw Error(`Saved operation ${command.operation_id} returned, but its retained envelope was removed or replaced. Current storage was left intact; reopen to inspect the current command.`);pending=undefined;unresolved=false;await ensureWorkspaceSynced();await ensureWorkspaceSynced();if(!closed){invalidate();status.textContent=`Saved revision ${result.revision}${result.replayed?' (exact receipt replay)':''}. Inspect your windows; acknowledgement does not prove rendering.`;}}
    catch(error){if(!closed){invalidate();status.textContent=`Apply unresolved: ${String(error)}. Exact payload retained; close/reopen or retry. Viewport changes never alter a retry.`;}throw error;}
  }));
  const discard=button('Read state and discard retry','Read authoritative state before discarding retained layout command',()=>void run(async()=>{const retained=sessionStorage.getItem(key);if(pending&&!retainedCommandMatches(retained,pending))throw Error('Retained command changed; reopen before discarding');const r=await current();if(closed)return;if(!confirm(`Read saved revision ${r.revision}. Discard the retained command? This does not roll back layout or prove the earlier outcome; an in-flight request may finish.`))return;if(!clearRetainedEnvelope(sessionStorage,key,retained))throw Error('Retained command changed during the state read; nothing was discarded. Reopen to inspect it.');pending=undefined;unresolved=false;blocked=false;invalidate();await load();}));
  const close=button('Close','Close saved workspace layouts',()=>dialog.close());
  picker.onchange=()=>{replacements={};mappings.replaceChildren();invalidate();};
  const timer=setInterval(()=>{if(!preview||busy||unresolved)return;try{if(JSON.stringify(measuredViewport(viewport()))!==JSON.stringify(preview.viewport))invalidate('Viewport changed. Preview again.');}catch{invalidate('Viewport is too small. Enlarge it and preview again.');}},300);
  dialog.addEventListener('close',()=>{closed=true;clearInterval(timer);dialog.remove();});
  list.append(picker,name,save,rename,remove,stage,apply,refresh,discard,close);
  dialog.append(el('h2','','Saved workspace layouts'),el('p','','Save geometry, order, view and Docking placement for existing windows. Stable IDs match first; missing windows require explicit replacements.'),list,status,summary,mappings,drawing);
  document.body.append(dialog);dialog.showModal();controls();void run(load);
}
