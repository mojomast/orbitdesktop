import type {Workspace} from './model';
// Compatible presets use existing validated appearance fields: no live backend restart.
export function themePersonality(a:Workspace['appearance']):string {
 const variants:Record<string,[string,string]>={
 '#11112b':['midnight','nous'], '#0c1622':['midnight','relay'],
 '#102c40':['midnight','aurora'], '#06130c':['cyberpunk','phosphor'],
 '#0000a8':['classic','msdos'],
 '#12345a':['paper','blueprint'], '#f6d84b':['paper','pop'],
 '#092535':['midnight','ocean'], '#12271f':['midnight','forest'],
 '#291b32':['midnight','plum'], '#302019':['midnight','ember'],
 '#05060a':['midnight','deepfield'], '#f7edea':['paper','sakura'],
 '#120a00':['classic','amber'],
 };
 const match=variants[a?.background?.toLowerCase()??''];
 return match&&match[0]===a?.theme?match[1]:a?.theme??'';
}
