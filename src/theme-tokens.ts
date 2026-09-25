export const chromeThemes = ['midnight','xp','classic','paper','cyberpunk'] as const;
export type ChromeTheme = typeof chromeThemes[number];
export const themeColors = ['surfaceColor','panelColor','borderColor','mutedColor','titlebarColor','titlebarTextColor','buttonColor','buttonTextColor'] as const;
export interface ThemeTokens {
 theme?: ChromeTheme;
 surfaceColor?: string; panelColor?: string; borderColor?: string; mutedColor?: string;
 titlebarColor?: string; titlebarTextColor?: string; buttonColor?: string; buttonTextColor?: string;
 controlRadius?: number; titlebarHeight?: number; uiFont?: 'system'|'classic'|'mono';
}
export const themeKeys = ['theme',...themeColors,'controlRadius','titlebarHeight','uiFont'];
export function validateTheme(a:ThemeTokens) {
 if(a.theme!==undefined&&!chromeThemes.includes(a.theme))throw Error('Invalid chrome theme');
 for(const key of themeColors)if(a[key]!==undefined&&(typeof a[key]!=='string'||!/^#[0-9a-fA-F]{6}$/.test(a[key]!)))throw Error('Invalid theme color: '+key);
 for(const [key,min,max] of [['controlRadius',0,24],['titlebarHeight',24,64]] as const)if(a[key]!==undefined&&(!Number.isFinite(a[key])||a[key]!<min||a[key]!>max))throw Error('Invalid theme size: '+key);
 if(a.uiFont!==undefined&&!['system','classic','mono'].includes(a.uiFont))throw Error('Invalid UI font');
}
