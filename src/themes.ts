import type {Workspace} from './model';
import {themePersonality} from './theme-personality.ts';
import {themeKeys} from './theme-tokens.ts';
type Theme = NonNullable<Workspace['appearance']> & {name:string;description:string};
export const themes:Theme[] = [
 {name:'Nous Atelier',description:'Ultramarine celestial engraving, the Nous girl seal, indexed research ribbon and marginalia chat.',theme:'midnight',background:'#11112b',textColor:'#f0eeff',accentColor:'#aba8ff',cornerRadius:2},
 {name:'Hermes Relay',description:'Agent-ops console: ink-navy panels, amber signal rails and a live tool-call timeline.',theme:'midnight',background:'#0c1622',textColor:'#e9f1fa',accentColor:'#ffb347',cornerRadius:4},
 {name:'Midnight',description:'Quiet, modern graphite with lime highlights.',theme:'midnight',background:'#10141c',textColor:'#e8edf5',accentColor:'#b5f268',cornerRadius:12},
 {name:'Windows XP',description:'Luna-inspired blue title bars, green Start, tactile controls and warm panels.',theme:'xp',background:'#397bd1',textColor:'#172341',accentColor:'#245edb',cornerRadius:8},
 {name:'Classic 95',description:'Square beveled controls, gray panels and navy title bars.',theme:'classic',background:'#008080',textColor:'#111111',accentColor:'#000080',cornerRadius:0},
 {name:'MS-DOS',description:'CGA blue screen, double-line box borders, monospace command prompt and a blinking text cursor.',theme:'classic',background:'#0000a8',textColor:'#a8a8a8',accentColor:'#ffff55',cornerRadius:0,surfaceColor:'#000000',panelColor:'#0000a8',borderColor:'#a8a8a8',mutedColor:'#5f5f5f',titlebarColor:'#0000a8',titlebarTextColor:'#fcfcfc',buttonColor:'#a8a8a8',buttonTextColor:'#000000',controlRadius:0,titlebarHeight:28,uiFont:'mono'},
 {name:'Paper Studio',description:'Warm editorial canvas, ink outlines and hard offset shadows.',theme:'paper',background:'#e9e1d2',textColor:'#29251f',accentColor:'#93432d',cornerRadius:2},
 {name:'Cyberpunk',description:'Angular black panels, cyan edges and electric pink accents.',theme:'cyberpunk',background:'#090b16',textColor:'#e6fbff',accentColor:'#ff58cf',cornerRadius:0},
 {name:'Aurora Glass',description:'Frosted floating dock, luminous glass borders and softly lifting controls.',theme:'midnight',background:'#102c40',textColor:'#e5faff',accentColor:'#83eddd',cornerRadius:20},
 {name:'Phosphor',description:'Green terminal desktop, scanline chrome and command-log chat.',theme:'cyberpunk',background:'#06130c',textColor:'#b7ffd0',accentColor:'#78ffa2',cornerRadius:0},
 {name:'Blueprint',description:'Drafting grid, dimension-line borders and technical notebook chat.',theme:'paper',background:'#12345a',textColor:'#e6f3ff',accentColor:'#a9dcff',cornerRadius:0},
 {name:'Pop Art',description:'Heavy ink outlines, offset shadows and tactile press-down controls.',theme:'paper',background:'#f6d84b',textColor:'#201b35',accentColor:'#9b245e',cornerRadius:12},
 {name:'Ocean',description:'Porthole controls and a translucent deep-sea dock.',theme:'midnight',background:'#092535',textColor:'#e0f4ff',accentColor:'#63d8ef',cornerRadius:16},
 {name:'Forest',description:'Soft green workspace.',theme:'midnight',background:'#12271f',textColor:'#e6f3e9',accentColor:'#97dfaa',cornerRadius:14},
 {name:'Plum',description:'Violet workspace.',theme:'midnight',background:'#291b32',textColor:'#f4e9fc',accentColor:'#dbacf4',cornerRadius:18},
 {name:'Ember',description:'Warm amber workspace.',theme:'midnight',background:'#302019',textColor:'#fff0df',accentColor:'#ffbd80',cornerRadius:10},
 {name:'Deep Field',description:'Deep-space observatory: near-black instrument panels, faint nebulae and pale-gold starlight.',theme:'midnight',background:'#05060a',textColor:'#e6ebff',accentColor:'#e8c37a',cornerRadius:2},
 {name:'Sakura',description:'Soft spring paper: warm cream canvas, ink text and drifting blossom petals.',theme:'paper',background:'#f7edea',textColor:'#3a2b2f',accentColor:'#c24b6b',cornerRadius:14},
 {name:'Amber CRT',description:'Monochrome amber terminal: black glass, glowing phosphor, scanlines and a mono command line.',theme:'classic',background:'#120a00',textColor:'#ffb642',accentColor:'#ffd27f',cornerRadius:0,surfaceColor:'#0b0600',panelColor:'#1c1000',borderColor:'#8a5a12',mutedColor:'#b07a2a',titlebarColor:'#241300',titlebarTextColor:'#ffd9a0',buttonColor:'#26170a',buttonTextColor:'#ffcf8a',controlRadius:0,titlebarHeight:28,uiFont:'mono'},
];
export function themePatch(name:string):NonNullable<Workspace['appearance']> {
 const theme=themes.find(t=>t.name===name);if(!theme)throw Error('Unknown workspace theme');
 const {name:_,description:__,...patch}=theme;return {...patch,wallpaper:`/wallpapers/${themePersonality(theme)}.svg`,wallpaperFit:'cover'};
}

// Explicit preset tokens belong to that preset, not to the owner's custom
// overrides. Remove only unchanged preset defaults that the next preset omits.
export function themeResetKeys(current:Workspace['appearance'],name:string):(keyof NonNullable<Workspace['appearance']>)[] {
 const next=themePatch(name);
 const previous=themes.find(theme=>themePersonality(theme)===themePersonality(current));
 if(!current||!previous)return [];
 return (themeKeys as (keyof NonNullable<Workspace['appearance']>)[]).filter(key=>key!=='theme'&&previous[key]!==undefined&&current[key]===previous[key]&&next[key]===undefined);
}
