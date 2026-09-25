import {applyChrome} from './theme-chrome';
import type { Workspace } from './model';
export function applyAppearance(state:Workspace) {
 const target=document.querySelector<HTMLElement>('.workspace');if(!target)return;
 const a=state.appearance;
 applyChrome(a);
 window.dispatchEvent(new CustomEvent('orbit-wallpaper-state',{detail:a?.wallpaper===''}));
 window.dispatchEvent(new CustomEvent('orbit-viewport-state',{detail:a?.fullViewport===true}));
 let sheet=document.querySelector<HTMLStyleElement>('#orbit-appearance-tokens');if(!sheet){sheet=document.createElement('style');sheet.id='orbit-appearance-tokens';document.head.append(sheet);}
 sheet.textContent=(a?.textColor ? `.monitor {color:${a.textColor}!important}` : '') + (a?.cornerRadius!==undefined ? `.monitor {border-radius:${a.cornerRadius}px!important}` : '');
 sheet.textContent += `#app{--orbit-header:${a?.headerHeight??44}px;--orbit-sidebar:${a?.sidebarWidth??290}px;--orbit-gap:${a?.workspaceGap??0}px;${a?.accentColor?`--lime:${a.accentColor};`:''}}`;
 document.querySelector('#app')?.classList.toggle('navigation-top',a?.navigationPosition==='top');
 for(const key of ['background-color','background-image','background-size','background-position','background-repeat'])target.style.removeProperty(key);
 if(!a)return;
 if(a.background)target.style.setProperty('background-color',a.background,'important');
 if(a.wallpaper!==undefined){target.style.setProperty('background-image',a.wallpaper?`url("${a.wallpaper}")`:'none','important');target.style.setProperty('background-size','cover','important');target.style.setProperty('background-position','center','important');target.style.setProperty('background-repeat','no-repeat','important');}
 if(a.wallpaperFit)target.style.setProperty('background-size',a.wallpaperFit,'important');
}
