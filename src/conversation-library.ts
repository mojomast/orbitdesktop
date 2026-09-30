import { el, button } from './dom';
import { workspaceId } from './workspace-sync';
import { conversationRequest } from './conversation-client';
import './conversation-library.css';

type Row = {session_id:string;profile_id:string;title:string;upstream_title?:string;pinned:boolean;archived:boolean;revision:number;catalog_missing?:boolean};
export function showConversationLibrary(getToken: () => string, targetPaneId?: string) {
  const dialog=el('dialog','hermes-tools-dialog conversation-library');
  dialog.setAttribute('aria-label','Conversation library');
  const status=el('p'); status.setAttribute('role','status');
  const profile=el('select'); profile.setAttribute('aria-label','Library profile');
  const search=el('input'); search.type='search'; search.placeholder='Search loaded titles or session IDs'; search.setAttribute('aria-label','Search conversations');
  const archived=el('input'); archived.type='checkbox'; archived.setAttribute('aria-label','Show archived conversations');
  const archiveLabel=el('label','','Show archived'); archiveLabel.append(archived);
  const list=el('div','conversation-library-list');
  let rows:Row[]=[], sequence=0, offset=0, open=true;
  const mutations=new Set<Row>();
  const api=(body:Record<string,unknown>) => conversationRequest(getToken,{...body,workspace_id:workspaceId,profile_id:profile.value});
  async function mutate(row:Row, patch:Record<string,unknown>, editor?:{name:HTMLInputElement;error:HTMLElement}) {
    if(mutations.has(row))return;
    const seq=sequence;
    const current=()=>open && dialog.open && seq===sequence && (!editor || dialog.contains(editor.name));
    const controls=Array.from(list.querySelectorAll<HTMLButtonElement>('button')).map(node=>({node,disabled:node.disabled}));
    mutations.add(row);
    for(const {node} of controls)node.disabled=true;
    if(editor){editor.name.disabled=true;editor.error.textContent='Saving name…';}
    try {
      const result=await conversationRequest(getToken,{action:'conversation_metadata',workspace_id:workspaceId,profile_id:row.profile_id,session_id:row.session_id,expected_revision:row.revision,patch});
      if (!current()) return;
      Object.assign(row,result.record);
      if(result.conflict && editor) {
        editor.error.textContent=`Metadata changed elsewhere. Current host name: ${row.title || row.upstream_title || row.session_id}. Your typed name is preserved; review and press Save name to retry.`;
      }else render();
      status.textContent=result.conflict ? 'Metadata changed elsewhere. Review before trying again.' : 'Orbit display metadata saved.';
    } catch(error) { if(current()) {status.textContent=String(error);if(editor)editor.error.textContent=`${String(error)} Your typed name is preserved.`;} }
    finally {
      mutations.delete(row);
      for(const {node,disabled} of controls)if(node.isConnected)node.disabled=disabled;
      if(editor && editor.name.isConnected)editor.name.disabled=false;
    }
  }
  function render() {
    const query=search.value.toLocaleLowerCase();
    list.replaceChildren();
    const filtered=rows.filter(row => (archived.checked || !row.archived) && `${row.title} ${row.upstream_title || ''} ${row.session_id}`.toLocaleLowerCase().includes(query)).sort((a,b)=>Number(b.pinned)-Number(a.pinned));
    for (const row of filtered) {
      const item=el('section','conversation-library-row');
      item.append(el('strong','',`${row.pinned ? '★ ' : ''}${row.title || row.upstream_title || row.session_id}${row.archived ? ' · Archived' : ''}`),el('small','',`${row.profile_id} · ${row.session_id}`));
      const actions=el('div');
      const reopen=button('Open here','Open conversation in selected pane',() => {window.dispatchEvent(new CustomEvent('orbit-select-conversation',{detail:{paneId:targetPaneId,profileId:row.profile_id,sessionId:row.session_id}}));dialog.close();});
      reopen.disabled=!targetPaneId;
      actions.append(reopen,button('New window','Open conversation in a new window',() => {window.dispatchEvent(new CustomEvent('orbit-open-conversation',{detail:{profileId:row.profile_id,sessionId:row.session_id}}));dialog.close();}),button('Rename','Rename Orbit display title',() => {
        const name=el('input');name.maxLength=200;name.value=row.title || row.upstream_title || '';name.setAttribute('aria-label','Orbit conversation name');
         const error=el('p');error.setAttribute('role','status');
         const save=button('Save name','Save Orbit display title',()=>void mutate(row,{title:name.value.trim()},{name,error}));actions.replaceChildren(name,save,button('Cancel','Cancel rename',render),error);name.focus();
      }),button(row.pinned?'Unpin':'Pin','Toggle conversation pin',()=>void mutate(row,{pinned:!row.pinned})),button(row.archived?'Unarchive':'Archive','Toggle Orbit archive flag',()=>void mutate(row,{archived:!row.archived})));
       item.append(actions);list.append(item);
    }
    if(!filtered.length)list.append(el('p','','No matching loaded conversations.'));
  }
  const more=button('Load more','Load next Hermes session page',()=>void load(true));more.hidden=true;
  async function load(append=false) {
    const seq=++sequence, next=append?offset+100:0;
    status.textContent='Loading conversation catalog…'; more.disabled=true;
    try {
      const data=await api({action:'conversation_library',offset:next});
      if(!open || seq!==sequence)return;
      offset=next;const incoming=data.conversations as Row[];
      rows=append?[...new Map([...rows,...incoming].map(row=>[row.session_id,row])).values()]:incoming;
      more.hidden=!data.has_more;status.textContent=data.supported===false?'Hermes catalog unavailable. Saved Orbit metadata is shown; opening still validates upstream.':data.note;render();
    }catch(error){if(open && seq===sequence)status.textContent=String(error);}
    finally {if(open && seq===sequence)more.disabled=false;}
  }
  profile.onchange=()=>{rows=[];render();void load();};search.oninput=render;archived.onchange=render;
  dialog.append(el('h2','','Conversation library'),button('Close','Close conversation library',()=>dialog.close()),el('p','','Names, pins and archives are private Orbit metadata. Archiving hides an entry here; it does not delete or archive the Hermes conversation.'),profile,search,archiveLabel,button('Refresh','Refresh conversation library',()=>void load()),status,list,more);
  dialog.addEventListener('close',()=>{open=false;sequence++;dialog.remove();});document.body.append(dialog);dialog.showModal();
  void conversationRequest(getToken,{action:'profiles'}).then(data=>{
    if(!open)return;
    for(const p of data.profiles){const option=el('option','',p.label);option.value=p.id;profile.append(option);}void load();
  }).catch(error=>{if(open)status.textContent=String(error);});
  return ()=>dialog.close();
}
