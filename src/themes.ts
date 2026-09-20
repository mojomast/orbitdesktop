export const themes = [
 {name:'Midnight',background:'#10141c',textColor:'#e8edf5',accentColor:'#b5f268',cornerRadius:12},
 {name:'Ocean',background:'#092535',textColor:'#e0f4ff',accentColor:'#63d8ef',cornerRadius:16},
 {name:'Forest',background:'#12271f',textColor:'#e6f3e9',accentColor:'#97dfaa',cornerRadius:14},
 {name:'Plum',background:'#291b32',textColor:'#f4e9fc',accentColor:'#dbacf4',cornerRadius:18},
 {name:'Ember',background:'#302019',textColor:'#fff0df',accentColor:'#ffbd80',cornerRadius:10},
] as const;
export function themePatch(name:string) {
 const theme=themes.find(t=>t.name===name);if(!theme)throw Error('Unknown workspace theme');
 const {name:_,...patch}=theme;return patch;
}
