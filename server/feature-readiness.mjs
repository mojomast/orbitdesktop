import fs from 'node:fs';
import path from 'node:path';
import {VOICE_MODEL,VOICE_REVISION,VOICE_FILES} from './voice-model-assets.mjs';
import {DATA_ENGINE_VERSION,DATA_ENGINE_PLATFORM,DATA_ENGINE_FILES} from './data-engine-assets.mjs';
import {MODEL_FILES} from './knowledge-model.mjs';

// Bounded stat-only observations; never construct services, read libraries, launch
// browsers, hash large assets or infer. Invocation independently checks integrity.
export function observeFeatureReadiness({root,runtimeRoot,env=process.env,mcpConfigured=false,now=Date.now}={}) {
  const present=(file,size)=>{try{const s=fs.lstatSync(file);return s.isFile()&&!s.isSymbolicLink()&&s.size>0&&(size===undefined||s.size===size);}catch{return false;}};
  const prerequisite=(id,ok)=>({id,state:ok?'present_unverified':'missing_or_invalid'});
  const semantic=MODEL_FILES.every(([name,size])=>present(path.join(runtimeRoot,'knowledge-index/model',name),size));
  const voiceRoot=env.ORBIT_VOICE_MODELS_ROOT??path.join(runtimeRoot,'models');
  const voice=Object.entries(VOICE_FILES).every(([name,[size]])=>present(path.join(voiceRoot,VOICE_MODEL,'resolve',VOICE_REVISION,name),size));
  const dataRoot=env.ORBIT_DUCKDB_EXTENSIONS_ROOT??path.join(runtimeRoot,'engines/duckdb');
  const extensions=Object.entries(DATA_ENGINE_FILES).map(([id,file])=>prerequisite(id,present(path.join(dataRoot,DATA_ENGINE_VERSION,DATA_ENGINE_PLATFORM,file.file),file.bytes)));
  const engine=['duckdb-eh.wasm','duckdb-browser-eh.worker.js'].every(name=>present(path.join(root,'node_modules/@duckdb/duckdb-wasm/dist',name)));
  const browser=!!env.ORBIT_BROWSER_EXECUTABLE&&!!env.ORBIT_BROWSER_ALLOWED_ORIGINS;
  const executable=browser&&present(env.ORBIT_BROWSER_EXECUTABLE);
  const base=detail=>({state:'unknown',detail,prerequisites:[]});
  return {observed_at:new Date(now()).toISOString(),features:{
    'knowledge-search':{state:'unknown',detail:`Keyword search needs no model; semantic model files ${semantic?'present':'missing or invalid'}. Integrity, inference and source consent checked on action.`,prerequisites:[prerequisite('semantic_model_files',semantic)]},
    documents:base('Owner document operations; storage and editor checked on action.'),
    'interactive-results':base('Owner import/edit; payload and renderer checked on action.'),
    'run-traces':base('Owner read/export; trace availability checked on action.'),
    'voice-transcript':{state:voice?'unknown':'missing_prerequisite',detail:voice?'Model files present; integrity, browser audio and inference unknown until action.':'Voice model files missing or invalid; provision voice models. Browser audio remains unknown.',prerequisites:[prerequisite('voice_model_files',voice)]},
    'data-workbench':{state:engine?'unknown':'missing_prerequisite',detail:`DuckDB assets ${engine?'present':'missing'}; JSON/Parquet ${extensions.every(x=>x.state==='present_unverified')?'files present':'need extension assets'}. Integrity and browser execution checked on action.`,prerequisites:[prerequisite('duckdb_assets',engine),...extensions]},
    'browser-copilot':{state:executable?'unknown':'missing_prerequisite',detail:executable?'Browser configured; driver, origin policy and launch checked on action.':'Configure browser executable and allowed origins; executable must exist.',prerequisites:[prerequisite('browser_configuration',browser),prerequisite('browser_executable',executable)]},
    'mcp-apps':{state:mcpConfigured?'unknown':'missing_prerequisite',detail:mcpConfigured?'Proxy configured; browser reachability and snapshot checked on action.':'MCP Apps is off or proxy configuration unavailable.',prerequisites:[prerequisite('mcp_proxy_configuration',mcpConfigured)]},
  }};
}
