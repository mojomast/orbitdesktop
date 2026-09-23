import type {Workspace} from './model';
type Theme = NonNullable<Workspace['appearance']> & {name:string;description:string};
export const themes:Theme[] = [
 {name:'Midnight',description:'Quiet, modern graphite with lime highlights.',theme:'midnight',background:'#10141c',textColor:'#e8edf5',accentColor:'#b5f268',cornerRadius:12},
 {name:'Windows XP',description:'Luna-inspired blue title bars, green Start, tactile controls and warm panels.',theme:'xp',background:'#397bd1',textColor:'#172341',accentColor:'#245edb',cornerRadius:8},
 {name:'Classic 95',description:'Square beveled controls, gray panels and navy title bars.',theme:'classic',background:'#008080',textColor:'#111111',accentColor:'#000080',cornerRadius:0},
 {name:'Paper Studio',description:'Warm editorial canvas, ink outlines and hard offset shadows.',theme:'paper',background:'#e9e1d2',textColor:'#29251f',accentColor:'#93432d',cornerRadius:2},
 {name:'Cyberpunk',description:'Angular black panels, cyan edges and electric pink accents.',theme:'cyberpunk',background:'#090b16',textColor:'#e6fbff',accentColor:'#ff58cf',cornerRadius:0},
 {name:'Ocean',description:'Deep blue workspace.',theme:'midnight',background:'#092535',textColor:'#e0f4ff',accentColor:'#63d8ef',cornerRadius:16},
 {name:'Forest',description:'Soft green workspace.',theme:'midnight',background:'#12271f',textColor:'#e6f3e9',accentColor:'#97dfaa',cornerRadius:14},
 {name:'Plum',description:'Violet workspace.',theme:'midnight',background:'#291b32',textColor:'#f4e9fc',accentColor:'#dbacf4',cornerRadius:18},
 {name:'Ember',description:'Warm amber workspace.',theme:'midnight',background:'#302019',textColor:'#fff0df',accentColor:'#ffbd80',cornerRadius:10},
];
export function themePatch(name:string):NonNullable<Workspace['appearance']> {
 const theme=themes.find(t=>t.name===name);if(!theme)throw Error('Unknown workspace theme');
 const {name:_,description:__,...patch}=theme;return patch;
}
