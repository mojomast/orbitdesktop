import type { Workspace } from './model';
import {themeColors} from './theme-tokens';
import './theme-chrome.css';
import './theme-xp.css';
import './theme-95.css';
import './theme-personalities.css';
import './theme-taskbars.css';
import './theme-icon-surrounds.css';
import './theme-nous.css';
import {themePersonality} from './theme-personality';
export function applyChrome(a:Workspace['appearance']) {
 const root=document.documentElement;
 root.dataset.orbitStyle=themePersonality(a);
 if(a?.theme)root.dataset.orbitTheme=a.theme;else delete root.dataset.orbitTheme;
 for(const key of [...themeColors,'textColor','accentColor'] as const){const name='--theme-'+key;root.style.removeProperty(name);if(a?.[key])root.style.setProperty(name,a[key]!);}
 for(const key of ['controlRadius','titlebarHeight'] as const){root.style.removeProperty('--theme-'+key);if(a?.[key]!==undefined)root.style.setProperty('--theme-'+key,a[key]+'px');}
 root.style.removeProperty('--theme-title');
 if(a?.titlebarColor)root.style.setProperty('--theme-title',`linear-gradient(${a.titlebarColor},${a.titlebarColor})`);
 root.style.removeProperty('--theme-font');
 if(a?.uiFont)root.style.setProperty('--theme-font',({system:'system-ui, sans-serif',classic:'Tahoma, Verdana, sans-serif',mono:'ui-monospace, monospace'})[a.uiFont]);
}
