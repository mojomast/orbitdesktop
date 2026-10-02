// Reviewed metadata only. Never enumerate private library identities or titles.
export const FEATURE_CAPABILITIES = Object.freeze([
  ['knowledge-search','search','search/read',['UTF-8 text'],'contracts/resource-tools-v1.mjs'],
  ['documents','documents','create/read/save',['Lexical JSON','Excalidraw JSON'],'contracts/documents-v1.mjs'],
  ['interactive-results','interactive-results','import/read/edit',['A2UI v0.9 JSON','NDJSON'],'contracts/interactive-results-v1.mjs'],
  ['data-workbench','data','select/query',['CSV','JSON','Parquet'],'contracts/data-recipes-v1.mjs'],
  ['voice-transcript','voice','transcribe',['audio'],null],
  ['run-traces','traces','read/export',['JSON'],'contracts/run-trace-v1.mjs'],
  ['browser-copilot','browser-copilot','observe/execute',['bounded browser actions'],'contracts/browser-copilot-v1.mjs'],
  ['mcp-apps','mcp-apps','import/open',['self-contained HTML snapshot'],'contracts/mcp-apps-v1.mjs'],
]);
export function featureCapabilities({audience='controller',observation=null}={}) {
  return {version:1,generation:'orbit-feature-types-v3',observed_at:observation?.observed_at??null,
    freshness:{max_age_ms:30000,revalidate_on_action:true},features:FEATURE_CAPABILITIES.map(([id,surface,verbs,formats,schema])=>({
      feature_id:id,surface_uri:`orbit://surface/${surface}`,open:{authority:'workspace_layout',effect:'open_surface'},
      content:{authority:'owner',availability:audience==='owner'?'owner_authenticated':'not_granted',verbs:verbs.split('/')},
      formats,schema_ref:schema,readiness:observation?.features[id]??{state:'unknown',detail:'Prerequisites not observed; check on action.',prerequisites:[]},
      execution_verified:false,delegated:{availability:['knowledge-search','documents'].includes(id)?'not_granted':'unsupported',channel:['knowledge-search','documents'].includes(id)?'pinned_normal_or_dedicated_local':'none'},
    }))};
}
