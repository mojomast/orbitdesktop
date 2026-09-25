import type {Workspace} from './model';
import {themePersonality} from './theme-personality.ts';
type Theme = NonNullable<Workspace['appearance']> & {name:string;description:string};
export const themes:Theme[] = [
 {name:'Nous Atelier',description:'Ultramarine celestial engraving, the Nous girl seal, indexed research ribbon and marginalia chat.',theme:'midnight',background:'#11112b',textColor:'#f0eeff',accentColor:'#aba8ff',cornerRadius:2},
 {name:'Midnight',description:'Quiet, modern graphite with lime highlights.',theme:'midnight',background:'#10141c',textColor:'#e8edf5',accentColor:'#b5f268',cornerRadius:12},
 {name:'Windows XP',description:'Luna-inspired blue title bars, green Start, tactile controls and warm panels.',theme:'xp',background:'#397bd1',textColor:'#172341',accentColor:'#245edb',cornerRadius:8},
 {name:'Classic 95',description:'Square beveled controls, gray panels and navy title bars.',theme:'classic',background:'#008080',textColor:'#111111',accentColor:'#000080',cornerRadius:0},
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
 // Owner-only brand set (kept out of version control; see docs/PERSONAL_BRAND_THEMES.md).
 {name:'Costco Warehouse',description:'Steel-blue warehouse panels, red aisle tabs and yellow price-sign highlights.',theme:'midnight',background:'#16283e',textColor:'#f2f6fb',accentColor:'#e32a36',cornerRadius:2},
 {name:'Maxi',description:'Deep blue aisles with bold yellow price tags and a red shelf rule.',theme:'midnight',background:'#002a6e',textColor:'#f4f8ff',accentColor:'#fff200',cornerRadius:8},
 {name:'Jimmy Dean Sunrise',description:'Warm sunrise diner: golden rays, red accents and cream menu cards.',theme:'paper',background:'#3a150c',textColor:'#fff3dc',accentColor:'#ffcf3f',cornerRadius:16},
 {name:'Preparation H Relief',description:'Clean clinical white and blue with a bright yellow relief rule.',theme:'midnight',background:'#eef4fa',textColor:'#0d2b4a',accentColor:'#0057a8',cornerRadius:10},
 {name:'Huggies Soft Touch',description:'Soft pastel clouds, pillowy panels and a warm red signature accent.',theme:'midnight',background:'#e8f6ff',textColor:'#123a5c',accentColor:'#da291c',cornerRadius:22},
 {name:'Outback Bush Camp',description:'Maroon camp leather, cream boomerang tabs and barbed-wire rules.',theme:'midnight',background:'#1a0f0d',textColor:'#f3e3c8',accentColor:'#e7cda2',cornerRadius:4},
];
export function themePatch(name:string):NonNullable<Workspace['appearance']> {
 const theme=themes.find(t=>t.name===name);if(!theme)throw Error('Unknown workspace theme');
 const {name:_,description:__,...patch}=theme;return {...patch,wallpaper:`/wallpapers/${themePersonality(theme)}.svg`,wallpaperFit:'cover'};
}
