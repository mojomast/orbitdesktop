import { el, button } from './dom';
import './desktop-icons.css';
interface Shortcut { id:string; title:string; icon:string; run:()=>void }
export function installDesktopIcons(host:HTMLElement, actions:()=>Shortcut[]) {
 const layer=el('nav','desktop-icons'); layer.setAttribute('aria-label','Desktop app shortcuts'); host.prepend(layer);
 let signature='';
 return () => {
  const items=actions(); const next=JSON.stringify(items.map(({id,title,icon})=>({id,title,icon})));
  if(next===signature)return; signature=next;
  const focused=(document.activeElement as HTMLElement)?.dataset.shortcut;
  layer.replaceChildren();
  for(const item of items){
   const b=button('',`Open ${item.title}`,()=>actions().find(a=>a.id===item.id)?.run(),'desktop-shortcut');
   b.dataset.shortcut=item.id;b.title=item.title;
   const glyph=el('span','desktop-shortcut-icon',item.icon);glyph.setAttribute('aria-hidden','true');
   b.append(glyph,el('span','desktop-shortcut-label',item.title));layer.append(b);
   if(focused===item.id)b.focus();
  }
 };
}
