import './viewport.css';
export function installViewport(app:HTMLElement, initial:boolean|undefined, changed:(value:boolean)=>void){
 const toggle=document.createElement('button');toggle.className='viewport-toggle';toggle.type='button';
 let expanded=false;try{expanded=localStorage.getItem('orbit.fullViewport')==='true';}catch{}
 function render(){app.classList.toggle('full-viewport',expanded);toggle.textContent=expanded?'↙ Controls':'⛶ Full viewport';toggle.setAttribute('aria-label',expanded?'Exit full viewport':'Use full viewport');toggle.setAttribute('aria-pressed',String(expanded));toggle.title='Toggle full viewport (Ctrl+Alt+F)';window.dispatchEvent(new Event('resize'));}
 if(initial!==undefined)expanded=initial;
 window.addEventListener('orbit-viewport-state',e=>{expanded=(e as CustomEvent<boolean>).detail;render();});
 toggle.onclick=()=>{expanded=!expanded;changed(expanded);try{localStorage.setItem('orbit.fullViewport',String(expanded));}catch{}render();};
 document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.altKey&&e.code==='KeyF'){e.preventDefault();toggle.click();}});
 app.append(toggle);render();
}
