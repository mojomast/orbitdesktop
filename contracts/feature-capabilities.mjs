// Reviewed feature types only: never enumerate private library identities/titles.
export const FEATURE_CAPABILITIES = Object.freeze([
  ['knowledge-search','search','keyword_ready','search/read','owner'],
  ['documents','documents','ready','create/read/save','owner'],
  ['interactive-results','interactive-results','ready','import/read/edit','owner'],
  ['data-workbench','data','browser_required','select/query','owner'],
  ['voice-transcript','voice','probe_required','transcribe','owner'],
  ['run-traces','traces','ready','read/export','owner'],
  ['browser-copilot','browser-copilot','probe_required','observe/execute','owner'],
  ['mcp-apps','mcp-apps','probe_required','import/open','owner'],
]);
export function featureCapabilities({audience='controller'}={}) {
  return {version:1,generation:'orbit-feature-types-v2',freshness:'static_contract; readiness must be checked at invocation',features:FEATURE_CAPABILITIES.map(([id,surface,readiness,verbs])=>({
    feature_id:id,surface_uri:`orbit://surface/${surface}`,open:{authority:'workspace_layout',effect:'open_surface'},
    content:{authority:'owner',availability:audience==='owner'?'owner_authenticated':'not_granted',verbs:verbs.split('/')},
    readiness,readiness_observation:'contract_only; service not probed',schema_ref:id==='documents'?'contracts/documents-v1.mjs':id==='knowledge-search'?'contracts/resource-tools-v1.mjs':null,
    execution_verified:false,delegated:{availability:['knowledge-search','documents'].includes(id)?'not_granted':'unsupported',channel:['knowledge-search','documents'].includes(id)?'pinned_normal_or_dedicated_local':'none'},
  }))};
}
