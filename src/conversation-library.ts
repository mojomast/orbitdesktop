import { el, button } from './dom';
import { workspaceId } from './workspace-sync';
import { conversationRequest } from './conversation-client';
import './conversation-library.css';
import type { ConversationSelection } from './conversation-selection';

type Row = {session_id:string;profile_id:string;title:string;upstream_title?:string;pinned:boolean;archived:boolean;revision:number;catalog_missing?:boolean};
const browsing = new Map<string,{query:string;archived:boolean}>();
export function showConversationLibrary(getToken: () => string, targetPaneId?: string, activeProfile?: string) {
  const dialog=el('dialog','hermes-tools-dialog conversation-library');
  dialog.setAttribute('aria-label','Conversation library');
  const status=el('p'); status.setAttribute('role','status');
  const profile=el('select'); profile.setAttribute('aria-label','Library profile');
  const search=el('input'); search.type='search'; search.placeholder='Search loaded titles or session IDs'; search.setAttribute('aria-label','Search conversations');
  const archived=el('input'); archived.type='checkbox'; archived.setAttribute('aria-label','Show archived conversations');
  const archiveLabel=el('label','','Show archived'); archiveLabel.append(archived);
  const remembered=browsing.get(workspaceId);search.value=remembered?.query??'';archived.checked=remembered?.archived??false;
  const selectionStatus=el('p');selectionStatus.setAttribute('role','status');
  let selection:AbortController|undefined, submitted=false;
  const cancelSelection=button('Cancel waiting choice','Cancel waiting conversation choice',()=>{selection?.abort();selection=undefined;selectionStatus.textContent='Conversation choice cancelled.';cancelSelection.hidden=true;});cancelSelection.hidden=true;
  function select(row:Row,newWindow=false){
    if(submitted){selectionStatus.textContent='A selection is already submitted. Wait for its result.';return;}
    selection?.abort();const controller=new AbortController();selection=controller;
    const report:ConversationSelection['report']=(phase,message)=>{
      if(!open || controller.signal.aborted || selection!==controller)return;
      submitted=phase==='opening';cancelSelection.hidden=phase!=='waiting';
      selectionStatus.textContent=message;
      if(phase==='opened'){dialog.close();}
    };
    report('waiting',`Waiting to open ${row.profile_id} · ${row.session_id}${newWindow?' in a new window':` in pane ${targetPaneId}`}.`);
    window.dispatchEvent(new CustomEvent(newWindow?'orbit-open-conversation':'orbit-select-conversation',{detail:{paneId:targetPaneId,profileId:row.profile_id,sessionId:row.session_id,signal:controller.signal,report}}));
  }
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
      const reopen=button('Open here','Open conversation in selected pane',() => select(row));
      reopen.disabled=!targetPaneId;
      actions.append(reopen,button('New window','Open conversation in a new window',() => select(row,true)),button('Rename','Rename Orbit display title',() => {
        const name=el('input');name.maxLength=200;name.value=row.title || row.upstream_title || '';name.setAttribute('aria-label','Orbit conversation name');
         const error=el('p');error.setAttribute('role','status');
         const save=button('Save name','Save Orbit display title',()=>void mutate(row,{title:name.value.trim()},{name,error}));actions.replaceChildren(name,save,button('Cancel','Cancel rename',render),error);name.focus();
      }),button(row.pinned?'Unpin':'Pin','Toggle conversation pin',()=>void mutate(row,{pinned:!row.pinned})),button(row.archived?'Unarchive':'Archive','Toggle Orbit archive flag',()=>void mutate(row,{archived:!row.archived})));
       item.append(actions);list.append(item);
    }
    if(!filtered.length)list.append(el('p','','No matching loaded conversations.'));
  }
  const more=button('Load more','Load next Hermes session page',()=>void load(true));more.hidden=true;
  let scanning=false, scanGeneration=0;
  const scan=button('Search older titles','Search up to 10 more catalog pages',async()=>{
    const generation=++scanGeneration;scanning=true;scan.disabled=true;cancelScan.hidden=false;
    let pages=0;
    while(open && generation===scanGeneration && !more.hidden && pages<10){
      if(!await load(true))break;
      pages++;
      if(generation===scanGeneration)status.textContent=`Searched ${pages} older pages. ${more.hidden?'Catalog complete.':'Partial catalog; searching older titles…'}`;
    }
    if(generation!==scanGeneration)return;
    scanning=false;scan.disabled=more.hidden;more.disabled=false;cancelScan.hidden=true;
    if(pages===10 && !more.hidden)status.textContent='Search budget reached (10 pages). Results are partial; search older titles again to continue.';
  });scan.disabled=true;
  const cancelScan=button('Cancel search','Cancel older-title search',()=>{scanGeneration++;sequence++;scanning=false;scan.disabled=more.hidden;more.disabled=false;cancelScan.hidden=true;status.textContent='Search cancelled. Loaded results are partial.';});cancelScan.hidden=true;
  async function load(append=false) {
    const seq=++sequence, next=append?offset+100:0;
    status.textContent='Loading conversation catalog…'; more.disabled=true;
    try {
      const data=await api({action:'conversation_library',offset:next});
      if(!open || seq!==sequence)return false;
      offset=next;const incoming=data.conversations as Row[];
      rows=append?[...new Map([...rows,...incoming].map(row=>[row.session_id,row])).values()]:incoming;
      more.hidden=!data.has_more || offset>=10000;status.textContent=data.supported===false?'Hermes catalog unavailable. Saved Orbit metadata is shown; opening still validates upstream.':`${data.note??''} ${data.has_more?'Partial catalog — older titles may remain.':'Catalog complete.'}`;render();return true;
    }catch(error){if(open && seq===sequence)status.textContent=String(error);return false;}
    finally {if(open && seq===sequence){more.disabled=scanning;scan.disabled=scanning||more.hidden;}}
  }
  const stopScan=()=>{scanGeneration++;sequence++;scanning=false;cancelScan.hidden=true;more.disabled=false;scan.disabled=more.hidden;};
  profile.onchange=()=>{stopScan();rows=[];render();void load();};search.oninput=render;archived.onchange=render;
  dialog.append(el('h2','','Conversation library'),button('Close','Close conversation library',()=>dialog.close()),el('p','','Names, pins and archives are private Orbit metadata. Archiving hides an entry here; it does not delete or archive the Hermes conversation.'),profile,search,archiveLabel,button('Refresh','Refresh conversation library',()=>{stopScan();void load();}),status,list,more);
  dialog.append(selectionStatus,cancelSelection,scan,cancelScan);
  dialog.addEventListener('close',()=>{browsing.set(workspaceId,{query:search.value,archived:archived.checked});selection?.abort();open=false;stopScan();dialog.remove();});document.body.append(dialog);dialog.showModal();
  void conversationRequest(getToken,{action:'profiles'}).then(data=>{
    if(!open)return;
    for(const p of data.profiles){const option=el('option','',p.label);option.value=p.id;profile.append(option);}if(activeProfile && Array.from(profile.options).some(p=>p.value===activeProfile))profile.value=activeProfile;void load();
  }).catch(error=>{if(open)status.textContent=String(error);});
  return ()=>dialog.close();
}
