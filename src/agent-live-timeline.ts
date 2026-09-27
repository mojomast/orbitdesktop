import type { LiveCategory, LiveConnection, LiveItem } from './agent-live-types';
import './agent-live-timeline.css';

const categories: [LiveCategory | 'all', string][] = [
  ['all', 'All'], ['agent', 'Agent'], ['tools', 'Tools'], ['files', 'Files'],
  ['checks', 'Checks'], ['evidence', 'Evidence'], ['warnings', 'Warnings'],
];
const labels: Record<LiveConnection, string> = {
  connecting: 'Connecting', connected: 'Connected', disconnected: 'Disconnected',
  unavailable: 'Unavailable', closed: 'Closed',
};
const authorityLabel = { agent: 'AGENT', observed: 'OBSERVED', recorder: 'RECORDER', human: 'YOU' } as const;
const cap = (s: unknown, n = 180) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '';
const validItem = (item: LiveItem): LiveItem => ({
  version: 1,
  id: cap(item.id, 200) || 'event',
  ...(Number.isSafeInteger(item.sequence) ? { sequence: item.sequence } : {}),
  at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : null,
  authority: item.authority,
  category: item.category,
  kind: cap(item.kind, 48) || 'event',
  summary: cap(item.summary, 240),
  status: item.status,
  ...(item.target ? { target: cap(item.target, 160) } : {}),
  ...(typeof item.duration_ms === 'number' && Number.isFinite(item.duration_ms) ? { duration_ms: Math.max(0, Math.min(item.duration_ms, 86400000)) } : {}),
  ...(item.fields ? { fields: item.fields.slice(0, 4).map(f => ({ label: cap(f.label, 32), value: typeof f.value === 'number' && Number.isFinite(f.value) ? f.value : cap(f.value, 80) })) } : {}),
  ...(item.reference ? { reference: { ...item.reference, id: cap(item.reference.id, 200) } } : {}),
});

export function createLiveTimeline(options: {
  storageKey: string;
  onOpenReference?: (item: LiveItem) => void;
}) {
  const root = document.createElement('section'); root.className = 'agent-live-timeline';
  root.setAttribute('aria-label', 'Live activity timeline');
  const connection = document.createElement('div'); connection.className = 'alt-connection'; connection.setAttribute('role', 'status'); connection.setAttribute('aria-live', 'polite');
  const toolbar = document.createElement('div'); toolbar.className = 'alt-toolbar';
  const filter = document.createElement('div'); filter.className = 'alt-filters'; filter.setAttribute('role', 'group'); filter.setAttribute('aria-label', 'Filter activity');
  let selected: LiveCategory | 'all' = 'all', query = '', follow = true, density: 'compact'|'detailed' = 'compact', collapseCompleted = false;
  try { const p = JSON.parse(localStorage.getItem(options.storageKey) || '{}'); if (p.density === 'detailed') density = 'detailed'; collapseCompleted = p.collapseCompleted === true; } catch {}
  const persist = () => { try { localStorage.setItem(options.storageKey, JSON.stringify({ density, collapseCompleted })); } catch {} };
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search summaries, targets, names'; search.setAttribute('aria-label', 'Search activity');
  search.maxLength = 100;
  const rows = document.createElement('div'); rows.className = 'alt-rows'; rows.setAttribute('role', 'list');
  const jumpFailure = document.createElement('button'); jumpFailure.type = 'button'; jumpFailure.textContent = 'First failure';
  const jumpLatest = document.createElement('button'); jumpLatest.type = 'button'; jumpLatest.textContent = 'Latest';
  const densityButton = document.createElement('button'); densityButton.type = 'button';
  const completedButton = document.createElement('button'); completedButton.type = 'button';
  const followButton = document.createElement('button'); followButton.type = 'button';
  const items = new Map<string, LiveItem>();
  const rowNodes = new Map<string, HTMLElement>();
  function savePrefs() { persist(); root.dataset.density = density; root.dataset.collapseCompleted = String(collapseCompleted); }
  function render() {
    const oldTop = rows.scrollTop, wasFollowing = follow;
    rows.replaceChildren(); rowNodes.clear();
    const all = [...items.values()].sort((a,b)=>(a.at ?? 0)-(b.at ?? 0)||(a.sequence ?? 0)-(b.sequence ?? 0));
    for (const item of all) {
      if (selected !== 'all' && item.category !== selected) continue;
      if (collapseCompleted && item.status === 'completed') continue;
      const needle = `${item.summary} ${item.target || ''} ${item.kind}`.toLowerCase(); if (query && !needle.includes(query)) continue;
      const row = document.createElement('details'); row.className = 'alt-row'; row.dataset.status = item.status; row.dataset.authority = item.authority; row.setAttribute('role','listitem');
      const head = document.createElement('div'); head.className = 'alt-row-head';
      const badge = document.createElement('span'); badge.className = `alt-authority alt-${item.authority}`; badge.textContent = authorityLabel[item.authority];
      const icon = document.createElement('span'); icon.className = 'alt-status-icon'; icon.setAttribute('aria-hidden','true'); icon.textContent = ({failed:'!',waiting:'…',running:'◌',completed:'✓',denied:'×',stopped:'■',cancelled:'■',pending:'○',ready:'○',unknown:'?',info:'·'} as const)[item.status];
      const statusText = document.createElement('span'); statusText.className = 'alt-status-text'; statusText.textContent = item.status;
      const kind = document.createElement('span'); kind.className = 'alt-kind'; kind.textContent = item.kind;
      head.append(badge, icon, statusText, kind);
      const summary = document.createElement('p'); summary.className = 'alt-summary'; summary.textContent = item.summary;
      const disclosure = document.createElement('summary'); disclosure.append(head,summary);
      if (item.target) { const target = document.createElement('span'); target.className='alt-target'; target.textContent=item.target; disclosure.append(target); }
      row.append(disclosure);
      if (density === 'detailed') for (const field of item.fields || []) { const line=document.createElement('p'); line.className='alt-field'; line.textContent=`${field.label}: ${field.value}`; row.append(line); }
      const actions = document.createElement('div'); actions.className = 'alt-actions';
      const copy = document.createElement('button'); copy.type='button'; copy.textContent='Copy safe ID'; copy.setAttribute('aria-label',`Copy safe ID ${item.id}`); copy.addEventListener('click',()=>void navigator.clipboard?.writeText(item.id)); actions.append(copy);
      if (item.reference && options.onOpenReference) { const open=document.createElement('button'); open.type='button'; open.textContent='Open details'; open.addEventListener('click',()=>options.onOpenReference?.(item)); actions.append(open); }
      row.append(actions); row.addEventListener('toggle',()=>{if(row.open){follow=false;followButton.textContent='Resume following';}}); row.addEventListener('focusin',()=>{if(rows.scrollTop>0)follow=false;});
      rows.append(row); rowNodes.set(item.id,row);
    }
    if (wasFollowing) rows.scrollTop = rows.scrollHeight; else rows.scrollTop = oldTop;
  }
  for (const [value,label] of categories) { const b=document.createElement('button'); b.type='button'; b.textContent=label; b.setAttribute('aria-pressed',String(selected===value)); b.addEventListener('click',()=>{selected=value;for(const x of Array.from(filter.querySelectorAll('button')))x.setAttribute('aria-pressed',String(x===b));render();}); filter.append(b); }
  search.addEventListener('input',()=>{query=search.value.slice(0,100).toLowerCase();render();});
  densityButton.addEventListener('click',()=>{density=density==='compact'?'detailed':'compact';densityButton.textContent=density==='compact'?'Detailed':'Compact';savePrefs();render();});
  completedButton.addEventListener('click',()=>{collapseCompleted=!collapseCompleted;completedButton.setAttribute('aria-pressed',String(collapseCompleted));savePrefs();render();});
  followButton.addEventListener('click',()=>{follow=true;followButton.textContent='Following';rows.scrollTop=rows.scrollHeight;});
  jumpLatest.addEventListener('click',()=>{follow=true;rows.scrollTop=rows.scrollHeight;followButton.textContent='Following';});
  jumpFailure.addEventListener('click',()=>{const row=Array.from(rows.querySelectorAll<HTMLElement>('.alt-row[data-status="failed"]'))[0];if(row){follow=false;row.scrollIntoView({block:'nearest'});row.focus();}});
  densityButton.textContent=density==='compact'?'Detailed':'Compact'; completedButton.textContent='Collapse completed'; completedButton.setAttribute('aria-pressed',String(collapseCompleted)); followButton.textContent='Following';
  toolbar.append(filter, search, densityButton, completedButton, jumpFailure, jumpLatest, followButton); root.append(connection,toolbar,rows); savePrefs();
  rows.addEventListener('scroll',()=>{const near=rows.scrollHeight-rows.scrollTop-rows.clientHeight<24;if(!near&&follow){follow=false;followButton.textContent='Resume following';}else if(near&&follow)followButton.textContent='Following';});
  let connectionState: LiveConnection = 'closed';
  return {
    element: root,
    upsert(next: LiveItem[]) {
      const cleaned=next.slice(-500).map(validItem);
      for(const item of cleaned) items.set(item.id,item);
      if(items.size>500){
        const ordered=[...items.values()].sort((a,b)=>{const priority=(i:LiveItem)=>i.status==='running'||i.status==='failed'?0:1;return priority(b)-priority(a)||(a.at??0)-(b.at??0);});
        while(items.size>500){const victim=ordered.shift();if(victim)items.delete(victim.id);}
      }
      render();
    },
    replace(next: LiveItem[]) { items.clear(); this.upsert(next); },
    reset() { items.clear(); render(); },
    setConnection(state: LiveConnection,message='') { connectionState=state; connection.textContent=`${labels[state]}${message?` · ${cap(message,180)}`:''}`; connection.dataset.state=connectionState; },
    dispose() { root.remove(); items.clear(); },
  };
}
