import type { Workspace } from './model';
export function applyAppearance(state:Workspace) {
 const target=document.querySelector<HTMLElement>('.workspace');if(!target)return;
 const a=state.appearance;
 for(const key of ['background-color','background-image','background-size','background-position','background-repeat'])target.style.removeProperty(key);
 if(!a)return;
 if(a.background)target.style.setProperty('background-color',a.background,'important');
 if(a.wallpaper!==undefined){target.style.setProperty('background-image',a.wallpaper?`url("${a.wallpaper}")`:'none','important');target.style.setProperty('background-size','cover','important');target.style.setProperty('background-position','center','important');target.style.setProperty('background-repeat','no-repeat','important');}
}
