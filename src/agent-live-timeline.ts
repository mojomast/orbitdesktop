import type { LiveCategory, LiveConnection, LiveItem } from './agent-live-types';
import './agent-live-timeline.css';

const categories: [LiveCategory | 'all', string][] = [['all','All'],['agent','Agent'],['tools','Tools'],['files','Files'],['checks','Checks'],['evidence','Evidence'],['warnings','Warnings']];
const categorySet = new Set<string>(categories.slice(1).map(([v])=>v));
const authorities = ['agent','observed','recorder','human'] as const;
const authoritySet = new Set<string>(authorities);
const authorityLabel = {agent:'AGENT',observed:'OBSERVED',recorder:'RECORDER',human:'YOU'} as const;
const statuses = ['ready','running','waiting','pending','completed','failed','denied','stopped','cancelled','unknown','info'] as const;
const statusSet = new Set<string>(statuses);
const connections = ['connecting','connected','disconnected','unavailable','closed'] as const;
const connectionSet = new Set<string>(connections);
const labels: Record<LiveConnection,string> = {connecting:'Connecting',connected:'Connected',disconnected:'Disconnected',unavailable:'Unavailable',closed:'Closed'};
const referenceKinds = ['toolcall','candidate','job','evidence','result','review','artifact','normal-tool'] as const;
const referenceSet = new Set<string>(referenceKinds);
const cap = (s: unknown,n=180) => typeof s==='string' ? s.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,n) : '';
const record = (v: unknown): v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
function validItem(value: unknown): LiveItem | null {
  if (!record(value) || value.version!==1 || !authoritySet.has(String(value.authority)) || !categorySet.has(String(value.category)) || !statusSet.has(String(value.status))) return null;
  const ref=record(value.reference) && referenceSet.has(String(value.reference.kind)) && typeof value.reference.id==='string'
    ? {kind:value.reference.kind as LiveItem['reference'] extends infer R ? R extends {kind:infer K}?K:never:never,id:cap(value.reference.id,200),...(typeof value.reference.candidate_id==='string'?{candidate_id:cap(value.reference.candidate_id,200)}:{}),...(Number.isSafeInteger(value.reference.generation)?{generation:value.reference.generation as number}:{}),...(typeof value.reference.hash==='string'?{hash:cap(value.reference.hash,128)}:{})}
    : undefined;
  const fields=Array.isArray(value.fields) ? value.fields.slice(0,12).filter(record).map(f=>({label:cap(f.label,32),value:typeof f.value==='number'&&Number.isFinite(f.value)?f.value:cap(f.value,80)})) : undefined;
  return {version:1,id:cap(value.id,200)||'event',...(Number.isSafeInteger(value.sequence)?{sequence:value.sequence as number}:{}),at:typeof value.at==='number'&&Number.isFinite(value.at)?value.at:null,authority:value.authority as LiveItem['authority'],category:value.category as LiveItem['category'],kind:cap(value.kind,48)||'event',summary:cap(value.summary,240),status:value.status as LiveItem['status'],...(value.target?{target:cap(value.target,160)}:{}),...(typeof value.duration_ms==='number'&&Number.isFinite(value.duration_ms)?{duration_ms:Math.max(0,Math.min(value.duration_ms,86400000))}:{}),...(fields?{fields}:{}),...(ref?{reference:ref}:{})};
}
const failureLike = (item: LiveItem) => item.status==='failed'||item.status==='denied'||item.status==='unknown';
const protectedItem = (item: LiveItem) => ['running','pending','waiting','unknown'].includes(item.status);
const statusIcon = {failed:'!',waiting:'…',running:'◌',completed:'✓',denied:'×',stopped:'■',cancelled:'■',pending:'○',ready:'○',unknown:'?',info:'·'} as const;
type RowState = {node:HTMLDetailsElement; badge:HTMLElement; icon:HTMLElement; status:HTMLElement; kind:HTMLElement; summary:HTMLElement; target:HTMLElement; meta:HTMLElement; fields:HTMLElement; copy:HTMLButtonElement; open?:HTMLButtonElement};

export function createLiveTimeline(options:{storageKey:string;onOpenReference?:(item:LiveItem)=>void}) {
  const root=document.createElement('section');root.className='agent-live-timeline';root.setAttribute('aria-label','Live activity timeline');
  const connection=document.createElement('div');connection.className='alt-connection';connection.setAttribute('role','status');connection.setAttribute('aria-live','polite');
  const toolbar=document.createElement('div');toolbar.className='alt-toolbar';
  const filter=document.createElement('div');filter.className='alt-filters';filter.setAttribute('role','group');filter.setAttribute('aria-label','Filter activity');
  let selected:LiveCategory|'all'='all',query='',follow=true,density:'compact'|'detailed'='compact',collapseCompleted=false;
  try{const p=JSON.parse(localStorage.getItem(options.storageKey)||'{}');if(p.density==='detailed')density='detailed';collapseCompleted=p.collapseCompleted===true;follow=p.follow!==false;if(typeof p.filter==='string'&&categorySet.has(p.filter))selected=p.filter as LiveCategory;if(typeof p.search==='string')query=cap(p.search,100).toLowerCase();}catch{}
  const persist=()=>{try{localStorage.setItem(options.storageKey,JSON.stringify({density,collapseCompleted,follow,filter:selected,search:query}));}catch{}};
  const search=document.createElement('input');search.type='search';search.placeholder='Search summaries, targets, names';search.setAttribute('aria-label','Search activity');search.maxLength=100;
  search.value=query;
  const count=document.createElement('div');count.className='alt-count';
  const rows=document.createElement('div');rows.className='alt-rows';rows.setAttribute('role','list');
  const overflow=document.createElement('div');overflow.className='alt-overflow';
  const firstFailure=document.createElement('button');firstFailure.type='button';firstFailure.textContent='First failure';
  const latest=document.createElement('button');latest.type='button';latest.textContent='Latest';
  const densityButton=document.createElement('button');densityButton.type='button';
  const completedButton=document.createElement('button');completedButton.type='button';completedButton.textContent='Collapse completed';
  const followButton=document.createElement('button');followButton.type='button';
  const items=new Map<string,LiveItem>(), rowNodes=new Map<string,RowState>();let dropped=0,protectedDropped=0,totalRejected=0,connectionState:LiveConnection='closed';
  function setFollow(value:boolean){follow=value;followButton.textContent=follow?'Pause following':'Resume following';persist();}
  function prefs(){root.dataset.density=density;root.dataset.collapseCompleted=String(collapseCompleted);densityButton.textContent=density==='compact'?'Detailed':'Compact';completedButton.setAttribute('aria-pressed',String(collapseCompleted));}
  function makeRow(item:LiveItem):RowState{
    const node=document.createElement('details');node.className='alt-row';node.setAttribute('role','listitem');
    const disclosure=document.createElement('summary'),head=document.createElement('div');head.className='alt-row-head';
    const badge=document.createElement('span'),icon=document.createElement('span'),status=document.createElement('span'),kind=document.createElement('span');badge.className='alt-authority';icon.className='alt-status-icon';icon.setAttribute('aria-hidden','true');status.className='alt-status-text';kind.className='alt-kind';head.append(badge,icon,status,kind);
    const summary=document.createElement('p');summary.className='alt-summary';const target=document.createElement('span');target.className='alt-target';const meta=document.createElement('span');meta.className='alt-meta';disclosure.append(head,summary,target,meta);node.append(disclosure);
    const fields=document.createElement('div');fields.className='alt-fields';node.append(fields);
    const actions=document.createElement('div');actions.className='alt-actions';const copy=document.createElement('button');copy.type='button';copy.textContent='Copy safe ID';actions.append(copy);node.append(actions);
    const state:RowState={node,badge,icon,status,kind,summary,target,meta,fields,copy};
    node.addEventListener('toggle',()=>{if(node.open)setFollow(false);});
    node.addEventListener('focusin',()=>{if(rows.scrollTop>0)setFollow(false);});
    return state;
  }
  function updateTime(state:RowState,item:LiveItem){
    const parts:string[]=[];if(item.at!==null)parts.push(new Date(item.at).toLocaleTimeString());
    // Durable rows describe a past transition, not an indefinitely running job.
    // Normal's adapter instead updates one current call row in place.
    if(item.sequence===undefined&&item.status==='running'&&item.at!==null)parts.push(`${Math.max(0,(Date.now()-item.at)/1000).toFixed(1)}s elapsed`);
    else if(item.duration_ms!==undefined)parts.push(`${(item.duration_ms/1000).toFixed(1)}s`);
    state.meta.textContent=parts.join(' · ');state.meta.hidden=!parts.length;
  }
  function updateRow(state:RowState,item:LiveItem){
    state.node.dataset.status=item.status;state.node.dataset.authority=item.authority;state.badge.className=`alt-authority alt-${item.authority}`;state.badge.textContent=authorityLabel[item.authority];
    state.icon.textContent=statusIcon[item.status];state.status.textContent=item.status;state.kind.textContent=item.kind;state.summary.textContent=item.summary;
    if(item.sequence!==undefined&&item.status==='unknown')state.summary.textContent+=' · Execution will not be replayed automatically';
    if(item.authority==='recorder'){
      const number=(name:string)=>item.fields?.find(field=>field.label===name&&typeof field.value==='number')?.value;
      const tests=number('tests'),passed=number('passed'),required=number('required_files'),covered=number('covered_files'),skipped=number('skipped');
      const counts:string[]=[];
      if(tests!==undefined&&passed!==undefined)counts.push(`${passed}/${tests} tests passed`);
      if(required!==undefined&&covered!==undefined)counts.push(`${covered}/${required} required files covered`);
      if(skipped!==undefined)counts.push(`${skipped} skipped`);
      if(counts.length)state.summary.textContent+=` · ${counts.join(' · ')}`;
    }
    state.target.textContent=item.target||'';state.target.hidden=!item.target;
    updateTime(state,item);
    state.fields.replaceChildren();for(const f of item.fields||[]){const p=document.createElement('p');p.className='alt-field';p.textContent=`${f.label}: ${f.value}`;state.fields.append(p);}state.fields.hidden=density!=='detailed'||!item.fields?.length;
    state.copy.setAttribute('aria-label',`Copy safe ID ${item.id}`);state.copy.onclick=()=>void navigator.clipboard?.writeText(items.get(item.id)?.id||item.id);
    if(item.reference&&options.onOpenReference){if(!state.open){state.open=document.createElement('button');state.open.type='button';state.open.textContent='Open details';state.node.querySelector('.alt-actions')?.append(state.open);}state.open.onclick=()=>{const current=items.get(item.id);if(current)options.onOpenReference?.(current);};}
    else{state.open?.remove();state.open=undefined;}
  }
  function render(){
    prefs();let visible=0;const all=[...items.values()].sort((a,b)=>a.sequence!==undefined&&b.sequence!==undefined?a.sequence-b.sequence:(a.at??0)-(b.at??0));
    const retained=new Set(items.keys());for(const [id,state] of rowNodes)if(!retained.has(id)){state.node.remove();rowNodes.delete(id);}
    for(const item of all){let state=rowNodes.get(item.id);if(!state){state=makeRow(item);rowNodes.set(item.id,state);}updateRow(state,item);
      const match=(selected==='all'||item.category===selected||(selected==='warnings'&&failureLike(item)))&&!(collapseCompleted&&item.status==='completed')&&(!query||`${item.summary} ${item.target||''} ${item.kind}`.toLowerCase().includes(query));
      state.node.hidden=!match;if(match)visible++;
    }
    // Reconcile positions without moving nodes already in the correct slot.
    let cursor=rows.firstElementChild;
    for(const item of all){const node=rowNodes.get(item.id)!.node;if(node===cursor){cursor=cursor.nextElementSibling;}else rows.insertBefore(node,cursor);}
    count.textContent=`Showing ${visible} of ${items.size} events`;
    overflow.textContent=dropped||totalRejected?`${dropped} events omitted by the 500-row limit${protectedDropped?` · ${protectedDropped} active/waiting/unknown priority events exceeded the row budget`:''}${totalRejected?` · ${totalRejected} invalid events rejected`:''}`:'';
  }
  for(const [value,label] of categories){const b=document.createElement('button');b.type='button';b.textContent=label;b.setAttribute('aria-pressed',String(selected===value));b.addEventListener('click',()=>{selected=value;for(const x of Array.from(filter.querySelectorAll('button')))x.setAttribute('aria-pressed',String(x===b));persist();render();});filter.append(b);}
  search.addEventListener('input',()=>{query=search.value.slice(0,100).toLowerCase();persist();render();});
  densityButton.addEventListener('click',()=>{density=density==='compact'?'detailed':'compact';persist();render();});
  completedButton.addEventListener('click',()=>{collapseCompleted=!collapseCompleted;persist();render();});
  followButton.addEventListener('click',()=>{setFollow(!follow);if(follow)rows.scrollTop=rows.scrollHeight;});
  latest.addEventListener('click',()=>{setFollow(true);rows.scrollTop=rows.scrollHeight;});
  firstFailure.addEventListener('click',()=>{const row=Array.from(rows.querySelectorAll<HTMLDetailsElement>('.alt-row')).find(n=>!n.hidden&&['failed','denied','unknown'].includes(n.dataset.status||''));if(row){setFollow(false);row.tabIndex=-1;row.scrollIntoView({block:'nearest'});row.focus();}});
  toolbar.append(filter,search,densityButton,completedButton,firstFailure,latest,followButton);root.append(connection,toolbar,count,overflow,rows);prefs();setFollow(follow);
  rows.addEventListener('scroll',()=>{const near=rows.scrollHeight-rows.scrollTop-rows.clientHeight<24;if(!near&&follow)setFollow(false);});
  function retainBudget(){
    if(items.size<=500){dropped=0;protectedDropped=0;return;}
    const priority=[...items.values()].sort((a,b)=>Number(protectedItem(b))-Number(protectedItem(a))||Number(failureLike(b))-Number(failureLike(a))||(b.at??0)-(a.at??0));
    const keep=new Set(priority.slice(0,500).map(i=>i.id));dropped=items.size-keep.size;protectedDropped=[...items.values()].filter(i=>protectedItem(i)&&!keep.has(i.id)).length;
    for(const id of items.keys())if(!keep.has(id))items.delete(id);
  }
  const clock=setInterval(()=>{if(!root.isConnected)return;for(const [id,state] of rowNodes){const item=items.get(id);if(item?.status==='running'&&!state.node.hidden)updateTime(state,item);}},1000);
  return{
    element:root,
    upsert(next:LiveItem[]){const wasFollowing=follow,valid:LiveItem[]=[];for(const raw of next as unknown[]){const item=validItem(raw);if(item)valid.push(item);else totalRejected++;}for(const item of valid)items.set(item.id,item);retainBudget();render();if(wasFollowing){rows.scrollTop=rows.scrollHeight;}},
    replace(next:LiveItem[]){items.clear();rowNodes.clear();rows.replaceChildren();dropped=0;protectedDropped=0;totalRejected=0;this.upsert(next);},
    reset(){items.clear();rowNodes.clear();rows.replaceChildren();dropped=0;protectedDropped=0;totalRejected=0;render();},
    setConnection(state:LiveConnection,message=''){const safe=connectionSet.has(state)?state:'unavailable';connectionState=safe;connection.textContent=`${labels[connectionState]}${message?` · ${cap(message,180)}`:''}`;connection.dataset.state=connectionState;},
    dispose(){clearInterval(clock);root.remove();items.clear();rowNodes.clear();},
  };
}
