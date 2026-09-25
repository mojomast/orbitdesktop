import {createHash, randomUUID} from 'node:crypto';

// Canonical JSON for request identity, not for signing external services.
export function canonicalJson(value) {
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value!==null && typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function commandIdentity(body, actor) {
  return {
    workspaceId:body.workspace_id,
    actor,
    operationId:body.operation_id || randomUUID(),
    intent:body.intent || `Legacy ${body.action} request`,
    requestHash:createHash('sha256').update(canonicalJson(body)).digest('hex'),
    action:body.action,
    baseRevision:body.base_revision,
    legacy:body.operation_id===undefined,
  };
}
