import {createPane, setToken, type PaneView} from './panes';
import {connectWorkspace} from './workspace-sync';
import type {Workspace, Pane} from './model';
import {el, button} from './dom';
type Tab = {pane:Pane; name:string};
type Pref = {font:number; opacity:number};
export async function startMobile() {
  const root=document.getElementById('mobile-root')!; root.replaceChildren();
  const top=el('header','mobile-top'), title=el('strong','','Orbit · Pocket'), status=el('small','','Connecting…');
  const stage=el('main','mobile-stage'); stage.setAttribute('aria-label','Selected desktop pane');
  const bottom=el('nav','mobile-bottom'), picker=el('dialog','mobile-picker'), settings=el('dialog','mobile-settings');
  picker.setAttribute('aria-label','Desktop tabs'); settings.setAttribute('aria-label','Tab appearance');
  const search=el('input'); search.type='search'; search.placeholder='Find a tab…'; search.setAttribute('aria-label','Find a tab');
  const list=el('div','mobile-tab-list');
  picker.append(el('h2','','Your desktop tabs'),search,list,button('Done','Close tab picker',()=>picker.close()));
  let tabs:Tab[]=[], active=localStorage.getItem('orbit.mobile.selected')||'', state:Workspace;
  let prefs:Record<string,Pref>={}; try{prefs=JSON.parse(localStorage.getItem('orbit.mobile.prefs')||'{}');}catch{}
  const views=new Map<string,{view:PaneView;signature:string}>();
  const tabButton=button('Tabs','Choose desktop tab',()=>{renderList();picker.showModal();search.focus();});
  const fullscreen=button('⛶','Enter fullscreen',async()=>{
    if(root.classList.contains('mobile-fullscreen')){
      if(document.fullscreenElement)await document.exitFullscreen().catch(()=>{});
      setFullscreen(false);
    }else{
      setFullscreen(true);
      try{await root.requestFullscreen?.();}catch{/* Compact mode remains available when native fullscreen is blocked. */}
    }
  });
  function setFullscreen(on:boolean){
    root.classList.toggle('mobile-fullscreen',on);
    fullscreen.textContent=on?'↙':'⛶';
    fullscreen.setAttribute('aria-label',on?'Exit fullscreen':'Enter fullscreen');
    fullscreen.setAttribute('aria-pressed',String(on));
    syncViewport();
  }
  document.addEventListener('fullscreenchange',()=>setFullscreen(!!document.fullscreenElement));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.fullscreenElement)setFullscreen(false);});
  const actions=el('div','mobile-actions');
  actions.append(fullscreen,button('⚙','Customize this tab',()=>{loadSettings();settings.showModal();}));
  top.append(title,status,actions);
  bottom.append(button('‹','Previous tab',()=>step(-1)),tabButton,button('›','Next tab',()=>step(1)));
  root.append(top,stage,bottom,picker,settings);
  function preference():Pref {const p=prefs[active];return {font:Math.min(32,Math.max(9,Number(p?.font)||16)),opacity:Math.min(1,Math.max(.15,Number(p?.opacity)||.92))};}
  function savePref(){localStorage.setItem('orbit.mobile.prefs',JSON.stringify(prefs));applyPref();}
  function applyPref(){const p=preference(),v=views.get(active)?.view;if(v){v.setFont(p.font);v.element.style.opacity=String(p.opacity);}}
  function range(label:string,min:string,max:string,step:string,key:keyof Pref){
    const row=el('label','mobile-setting'), name=el('span','',label),value=el('output'),input=el('input');input.type='range';input.min=min;input.max=max;input.step=step;input.setAttribute('aria-label',label);
    input.oninput=()=>{prefs[active]={...preference(),[key]:Number(input.value)};value.textContent=key==='font'?`${input.value}px`:`${Math.round(Number(input.value)*100)}%`;savePref();};
    row.append(name,value,input);settings.append(row);return {input,value,key};
  }
  settings.append(el('h2','','Make room for you'),el('p','','Per-tab settings, saved on this phone. Your desktop layout stays unchanged.'));
  const controls=[range('Text / app scale','9','32','1','font'),range('Pane opacity','.15','1','.05','opacity')];
  settings.append(el('p','','Opacity fades the whole pane, including opaque apps, so your desktop wallpaper stays visible. Embedded apps keep their own browser sessions; terminal shells and linked Hermes chats are shared.'),button('Reset this tab','Reset tab appearance',()=>{delete prefs[active];savePref();loadSettings();}),button('Done','Close appearance settings',()=>settings.close()));
  function loadSettings(){const p=preference();for(const c of controls){c.input.value=String(p[c.key]);c.value.textContent=c.key==='font'?`${p.font}px`:`${Math.round(p.opacity*100)}%`;}}
  function renderList(){list.replaceChildren();for(const t of tabs.filter(t=>`${t.name} ${t.pane.kind}`.toLowerCase().includes(search.value.toLowerCase()))){const b=button('','Select '+t.name,()=>{choose(t.pane.id);picker.close();});b.className='mobile-tab-card';b.setAttribute('aria-current',String(t.pane.id===active));b.append(el('small','',t.pane.kind.toUpperCase()),el('strong','',t.name));list.append(b);}if(!list.childElementCount)list.append(el('p','','No matching open tabs.'));}
  search.oninput=renderList;
  function step(n:number){if(tabs.length)choose(tabs[(tabs.findIndex(t=>t.pane.id===active)+n+tabs.length)%tabs.length].pane.id);}
  function choose(id:string){
    const t=tabs.find(t=>t.pane.id===id);if(!t)return;active=id;localStorage.setItem('orbit.mobile.selected',id);
    let entry=views.get(id);const signature=JSON.stringify(t.pane);
    if(entry?.signature!==signature){entry?.view.dispose();entry?.view.element.remove();views.delete(id);entry=undefined;}
    if(!entry){const view=createPane(t.pane,preference().font,{kind:()=>{},split:()=>{},close:()=>{},url:()=>{}});entry={view,signature};views.set(id,entry);stage.append(view.element);}
    for(const [key,e]of views){e.view.element.hidden=key!==id;}
    title.textContent=t.name;tabButton.textContent=`Tabs · ${tabs.findIndex(t=>t.pane.id===id)+1} / ${tabs.length}`;
    applyPref();requestAnimationFrame(()=>entry!.view.resize());
  }
  function apply(next:Workspace){state=next;tabs=[];
    const a=next.appearance;root.style.backgroundColor=a?.background||'#10141c';root.style.backgroundImage=a?.wallpaper?`url(${JSON.stringify(a.wallpaper)})`:'none';root.style.backgroundSize=a?.wallpaperFit||'cover';root.style.backgroundPosition='center';root.style.backgroundRepeat='no-repeat';
    for(const m of next.monitors){const leaves:Pane[]=[];function walk(l:typeof m.layout){if(l.type==='pane')leaves.push(l.pane);else{walk(l.first);walk(l.second);}}walk(m.layout);leaves.forEach((pane,i)=>tabs.push({pane,name:m.name+(leaves.length>1?` · ${i+1}`:'')}));}
    for(const[id,e]of views)if(!tabs.some(t=>t.pane.id===id)){e.view.dispose();e.view.element.remove();views.delete(id);}
    if(tabs.length)choose(tabs.some(t=>t.pane.id===active)?active:tabs[0].pane.id);else{title.textContent='No open tabs';stage.replaceChildren();}
    renderList();
  }
  connectWorkspace(()=>state,apply,()=> 'pixel-device-session',message=>{status.textContent=message.includes('connected')?'Live desktop · shared sessions':message;});
  setToken('pixel-device-session');
  // VisualViewport shrinks for Android's keyboard even when the layout viewport does not.
  // Track its offset too: browsers may pan the page to expose the focused input.
  function syncViewport(){
    const vv=window.visualViewport;
    root.style.height=`${vv?.height??window.innerHeight}px`;
    root.style.width=`${vv?.width??window.innerWidth}px`;
    root.style.top=`${vv?.offsetTop??0}px`;
    root.style.left=`${vv?.offsetLeft??0}px`;
    root.style.setProperty('--mobile-visible-height',`${vv?.height??window.innerHeight}px`);
  }
  window.visualViewport?.addEventListener('resize',syncViewport);
  window.visualViewport?.addEventListener('scroll',syncViewport);
  window.addEventListener('resize',syncViewport);
  syncViewport();
  new ResizeObserver(()=>views.get(active)?.view.resize()).observe(stage);
}
