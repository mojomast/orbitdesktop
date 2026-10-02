import {validateSavedLayout, type SavedLayout} from './saved-workspace-layouts-plan.ts';
import {measuredViewport, type ArrangeViewport} from './workspace-arrange-plan.ts';
export interface PendingSavedLayout {
  action:'apply'; workspace_id:string; operation_id:string; intent:string; base_revision:number;
  layout:SavedLayout; viewport:ArrangeViewport; replacements:Record<string,string>;
}
export const savedLayoutPendingKey=(workspace:string)=>`orbit.saved-layout.pending.${workspace}`;
export function parsePendingSavedLayout(raw:string,workspace:string):PendingSavedLayout {
  if(raw.length>131072)throw Error('Retained layout is too large');
  const value=JSON.parse(raw),keys=['action','workspace_id','operation_id','intent','base_revision','layout','viewport','replacements'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))||value.action!=='apply'||value.workspace_id!==workspace||
    !/^[a-f0-9-]{36}$/i.test(value.operation_id)||typeof value.intent!=='string'||!value.intent.trim()||value.intent.length>160||!Number.isSafeInteger(value.base_revision)||value.base_revision<0)throw Error('Invalid retained layout command');
  validateSavedLayout(value.layout);measuredViewport(value.viewport);
  if(!value.replacements||typeof value.replacements!=='object'||Array.isArray(value.replacements)||Object.keys(value.replacements).length>100||Object.entries(value.replacements).some(([k,v])=>!value.layout.windows.some((w:{id:string})=>w.id===k)||typeof v!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(v)))throw Error('Invalid retained replacements');
  return value;
}
export function retainSavedLayout(storage:Storage,command:PendingSavedLayout) {
  const raw=JSON.stringify(command);parsePendingSavedLayout(raw,command.workspace_id);
  const key=savedLayoutPendingKey(command.workspace_id);storage.setItem(key,raw);
  if(storage.getItem(key)!==raw)throw Error('Exact command could not be retained; nothing dispatched');
}
