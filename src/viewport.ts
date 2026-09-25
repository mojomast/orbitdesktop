import './viewport.css';
export function installViewport(app:HTMLElement, initial:boolean|undefined, changed:(value:boolean)=>void){
 const toggle=document.createElement('button');toggle.className='viewport-toggle';toggle.type='button';
 const exit=document.createElement('button');exit.className='viewport-exit';exit.type='button';
 exit.textContent='↙';exit.hidden=true;
 exit.setAttribute('aria-label','Exit full viewport');exit.title='Exit full viewport (Ctrl+Alt+F)';
 let expanded=false;try{expanded=localStorage.getItem('orbit.fullViewport')==='true';}catch{}
 if(initial!==undefined)expanded=initial;
 function render(){
  app.classList.toggle('full-viewport',expanded);
  toggle.textContent='Full viewport';
  toggle.dataset.icon=expanded?'↙':'⛶';
  toggle.setAttribute('aria-label','Full viewport');
  toggle.setAttribute('aria-pressed',String(expanded));
  toggle.title='Toggle full viewport (Ctrl+Alt+F)';
  exit.hidden=!expanded;
  window.dispatchEvent(new Event('resize'));
 }
 function set(value:boolean){expanded=value;changed(expanded);try{localStorage.setItem('orbit.fullViewport',String(expanded));}catch{}render();}
 window.addEventListener('orbit-viewport-state',e=>{expanded=(e as CustomEvent<boolean>).detail;render();});
 toggle.onclick=()=>set(!expanded);
 exit.onclick=()=>set(false);
 document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.altKey&&e.code==='KeyF'){e.preventDefault();set(!expanded);}});
 app.append(exit);render();
 return {button:toggle};
}
