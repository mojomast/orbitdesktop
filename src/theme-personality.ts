import type {Workspace} from './model';
// Compatible presets use existing validated appearance fields: no live backend restart.
export function themePersonality(a:Workspace['appearance']):string {
 const variants:Record<string,[string,string]>={
 '#11112b':['midnight','nous'],
 '#102c40':['midnight','aurora'], '#06130c':['cyberpunk','phosphor'],
 '#12345a':['paper','blueprint'], '#f6d84b':['paper','pop'],
 '#092535':['midnight','ocean'], '#12271f':['midnight','forest'],
 '#291b32':['midnight','plum'], '#302019':['midnight','ember'],
 // Owner-only brand set (background hex -> [family, style id]).
 '#16283e':['midnight','costco'], '#002a6e':['midnight','maxi'],
 '#3a150c':['paper','jimmydean'], '#eef4fa':['midnight','preph'],
 '#e8f6ff':['midnight','huggies'], '#1a0f0d':['midnight','outback'],
 };
 const match=variants[a?.background?.toLowerCase()??''];
 return match&&match[0]===a?.theme?match[1]:a?.theme??'';
}
