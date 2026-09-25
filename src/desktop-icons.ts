import { el, button } from './dom';
import './desktop-icons.css';
import {themeIcon,iconRole} from './theme-icons';
interface Shortcut { id:string; title:string; icon:string; pinned?:boolean; run:()=>void }
export function shortcutFolder(item: Shortcut): string {
 const name = `${item.id} ${item.title}`.toLowerCase();
 if (/cocs|supra|image|screenshot|omnivoice|planet/.test(name)) return 'Creative';
 if (/writer|calc|impress|office/.test(name)) return 'Office';
 if (/terminal|devplan|dev lab|performance|mimo/.test(name) || item.icon==='⌘') return 'Development';
 if (/hermes|companion|observatory|workshop/.test(name) || item.icon==='✦') return 'Hermes';
 return 'System & apps';
}
export function installDesktopIcons(host:HTMLElement, actions:()=>Shortcut[]) {
 const layer=el('nav','desktop-icons'); layer.setAttribute('aria-label','Desktop app folders'); host.prepend(layer);
 let signature=''; let opened:string|null=null;
 const render=()=>{
  const items=actions();
  const focused=(document.activeElement as HTMLElement)?.dataset.shortcut;
  layer.replaceChildren();
  const groups=new Map<string,Shortcut[]>();
  for(const item of items.filter(item=>!item.pinned)){const group=shortcutFolder(item);groups.set(group,[...(groups.get(group)||[]),item]);}
  const addShortcut=(item:Shortcut, parent:HTMLElement)=>{
   const b=button('',`Open ${item.title}`,()=>{opened=null;render();actions().find(a=>a.id===item.id)?.run();},'desktop-shortcut');
   b.dataset.shortcut=item.id;b.title=item.title;
   const glyph=themeIcon(iconRole(item.title,item.icon),'desktop-shortcut-icon');
   b.append(glyph,el('span','desktop-shortcut-label',item.title));parent.append(b);
   if(focused===item.id)b.focus();
  };
  for(const item of items.filter(item=>item.pinned))addShortcut(item,layer);
  for(const name of ['Hermes','Creative','Development','Office','System & apps']){
   const members=groups.get(name);if(!members)continue;
   const b=button('',`Open ${name} folder`,()=>{opened=opened===name?null:name;render();if(opened)layer.querySelector<HTMLButtonElement>('.desktop-folder-close')?.focus();},'desktop-shortcut desktop-folder');
   b.dataset.shortcut=`folder:${name}`;b.setAttribute('aria-expanded',String(opened===name));
   b.append(themeIcon('folder','desktop-shortcut-icon'),el('span','desktop-shortcut-label',name),el('span','desktop-folder-count',`${members.length} items`));layer.append(b);
   if(focused===`folder:${name}`)b.focus();
  }
  if(opened && groups.has(opened)){
   const name=opened;
   const panel=el('section','desktop-folder-panel');panel.setAttribute('aria-label',`${name} folder`);
   const close=()=>{opened=null;render();Array.from(layer.querySelectorAll<HTMLButtonElement>('.desktop-folder')).find(b=>b.dataset.shortcut===`folder:${name}`)?.focus();};
   const header=el('div','desktop-folder-header');header.append(el('strong','',name),button('×','Close folder',close,'desktop-folder-close'));
   const grid=el('div','desktop-folder-grid');for(const item of groups.get(name)!)addShortcut(item,grid);
   panel.append(header,grid);panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close();}});layer.append(panel);
  }
 };
 return () => {
  const next=JSON.stringify(actions().map(({id,title,icon,pinned})=>({id,title,icon,pinned})));
  if(next===signature)return;signature=next;render();
 };
}
