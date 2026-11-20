// Bounded, content-free observations; never construct services, read libraries,
// launch browsers, hash large assets or infer. Invocation independently checks
// integrity and source consent on action.
export function observeFeatureReadiness({now=Date.now}={}) {
  const base=detail=>({state:'unknown',detail,prerequisites:[]});
  return {observed_at:new Date(now()).toISOString(),features:{
    'knowledge-search':base('Shared sources keeps a keyword index of owner-added snapshots; source consent is checked on action.'),
    documents:base('Owner document operations; storage and editor checked on action.'),
    'interactive-results':base('Owner import/edit; payload and renderer checked on action.'),
    'run-traces':base('Owner read/export; trace availability checked on action.'),
  }};
}
