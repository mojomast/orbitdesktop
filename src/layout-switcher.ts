import {el,button} from './dom';
import {captureLayout,applyLayout,type SavedLayout} from './layout-presets';
import {id,type Workspace} from './model';
export function installLayoutSwitcher(host:HTMLElement, key:string, get:()=>Workspace,
  hidden:()=>string[], apply:(state:Workspace, minimized:string[])=>void, notify:(message:string)=>void) {
  let layouts:SavedLayout[]=[]; let active=''; let switching=false;
  try { const saved=JSON.parse(localStorage.getItem(key)||'null');
    if(saved && Array.isArray(saved.layouts) && saved.layouts.length<=32) {
      for(const layout of saved.layouts) {applyLayout(get(),layout); if(typeof layout.id!=='string') throw Error('Invalid ID');}
      layouts=saved.layouts; active=layouts.some(l=>l.id===saved.active)?saved.active:layouts[0]?.id;
    }
  } catch { notify('Saved layouts could not be read. Your current workspace is unchanged.'); }
  if(!layouts.length) { active=id(); layouts=[captureLayout(get(),'Main',active,hidden())]; }
  const wrap=el('div','layout-switcher');
  const toggle=button('','Choose workspace layout',()=>{ if(panel.hidden) {render();panel.hidden=false;toggle.setAttribute('aria-expanded','true');name.focus();} else close();},'layout-toggle');
  const panel=el('section','layout-panel'); panel.id='orbit-layout-panel';panel.hidden=true;
  panel.setAttribute('aria-label','Workspace layouts');toggle.setAttribute('aria-controls',panel.id);toggle.setAttribute('aria-expanded','false');
  const list=el('div','layout-list');
  const name=el('input','start-search') as HTMLInputElement; name.maxLength=80;name.placeholder='Name this layout';name.setAttribute('aria-label','Layout name');
  const persist=()=>{ try {localStorage.setItem(key,JSON.stringify({active,layouts}));} catch {notify('Layout storage is full or unavailable; changes are session-only.');} };
  function label(){const current=layouts.find(l=>l.id===active);toggle.textContent=`▦ ${current?.name || 'Layouts'} · ${get().view==='spatial'?'3D':'2D'}`;}
  function remember(){if(switching)return;const index=layouts.findIndex(l=>l.id===active);if(index>=0)layouts[index]=captureLayout(get(),layouts[index].name,active,hidden());persist();label();}
  function close(){panel.hidden=true;toggle.setAttribute('aria-expanded','false');}
  function render(){list.replaceChildren(); name.value=layouts.find(l=>l.id===active)?.name||'';
    for(const layout of layouts) {
      const item=button(`${layout.view==='spatial'?'◈ 3D':'▤ 2D'} · ${layout.name}`,`Switch layout ${layout.name}`,()=>{
        if(layout.id===active){close();return;} remember();
        try {const next=applyLayout(get(),layout);switching=true;apply(next,layout.minimized);active=layout.id;persist();label();close();toggle.focus();}
        catch {notify('Could not apply that layout.');} finally {switching=false;}
      });item.setAttribute('aria-pressed',String(layout.id===active));list.append(item);
    }
  }
  function title(){const value=name.value.trim();if(!value){notify('Enter a layout name.');name.focus();return null;}return value;}
  panel.append(el('strong','','Workspace layouts'),el('p','','Mix 2D desktops and 3D scenes. Positions, text sizes, minimized windows and camera are saved automatically in this browser. Apps and panes stay shared.'),list,name,
    button('＋ New from current','Create layout from current',()=>{const value=title();if(!value)return;if(layouts.length>=32){notify('Maximum 32 layouts.');return;}remember();active=id();layouts.push(captureLayout(get(),value,active,hidden()));persist();label();render();}),
    button('Rename','Rename current layout',()=>{const value=title();if(!value)return;layouts.find(l=>l.id===active)!.name=value;persist();label();render();}),
    button('Delete','Delete current layout',()=>{if(layouts.length===1){notify('Keep at least one layout.');return;}if(!window.confirm('Delete this saved layout? Open windows and apps will remain.'))return;const remaining=layouts.filter(l=>l.id!==active);const target=remaining[0];try{const next=applyLayout(get(),target);switching=true;apply(next,target.minimized);layouts=remaining;active=target.id;persist();label();render();}finally{switching=false;}}),
    button('Done','Close workspace layouts',()=>{close();toggle.focus();}));
  wrap.append(toggle,panel);host.append(wrap);label();
  document.addEventListener('pointerdown',event=>{if(!wrap.contains(event.target as Node))close();});
  wrap.addEventListener('keydown',event=>{if(event.key==='Escape'){close();toggle.focus();}});
  return {remember};
}
