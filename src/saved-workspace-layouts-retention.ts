type RetentionStorage = Pick<Storage, 'getItem' | 'removeItem'>;
type CommandIdentity = {operation_id:string;workspace_id:string};
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function retainedCommandMatches(raw:string|null,command:CommandIdentity):boolean {
  if(raw===null)return false;
  try {const stored=JSON.parse(raw);return stored?.operation_id===command.operation_id&&stored?.workspace_id===command.workspace_id&&canonical(stored)===canonical(command);}catch{return false;}
}
/** No await between comparison and removal: an old closure cannot erase a new envelope. */
export function clearRetainedCommand(storage:RetentionStorage,key:string,command:CommandIdentity):boolean {
  const raw=storage.getItem(key);if(!retainedCommandMatches(raw,command))return false;
  return clearRetainedEnvelope(storage,key,raw);
}
/** Also supports explicit discard of corrupt envelopes after an authoritative read. */
export function clearRetainedEnvelope(storage:RetentionStorage,key:string,expected:string|null):boolean {
  if(expected===null||storage.getItem(key)!==expected)return false;
  storage.removeItem(key);
  if(storage.getItem(key)!==null)throw Error('Retained command could not be cleared');
  return true;
}
