import fs from 'node:fs';
import path from 'node:path';
import {MODEL_FILES} from './knowledge-model.mjs';

// Bounded stat-only observations; never construct services, read libraries, launch
// browsers, hash large assets or infer. Invocation independently checks integrity.
export function observeFeatureReadiness({root,runtimeRoot,now=Date.now}={}) {
  const present=(file,size)=>{try{const s=fs.lstatSync(file);return s.isFile()&&!s.isSymbolicLink()&&s.size>0&&(size===undefined||s.size===size);}catch{return false;}};
  const prerequisite=(id,ok)=>({id,state:ok?'present_unverified':'missing_or_invalid'});
  const semantic=MODEL_FILES.every(([name,size])=>present(path.join(runtimeRoot,'knowledge-index/model',name),size));
  const base=detail=>({state:'unknown',detail,prerequisites:[]});
  return {observed_at:new Date(now()).toISOString(),features:{
    'knowledge-search':{state:'unknown',detail:`Keyword search needs no model; semantic model files ${semantic?'present':'missing or invalid'}. Integrity, inference and source consent checked on action.`,prerequisites:[prerequisite('semantic_model_files',semantic)]},
    documents:base('Owner document operations; storage and editor checked on action.'),
    'interactive-results':base('Owner import/edit; payload and renderer checked on action.'),
    'run-traces':base('Owner read/export; trace availability checked on action.'),
  }};
}
