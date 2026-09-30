import { id, monitor, leaves, type Workspace, type Monitor } from './model.ts';
import { validatePluginConfigSchema, assertValidPluginConfig, applyConfigDefaults, type PluginConfigSchema } from './plugin-config-schema.ts';
export interface PluginManifest { apiVersion: 1; id: string; version: string; title: string; entry: string; configSchema?: PluginConfigSchema }
export interface PluginInstance { instance_id?: string; manifest: PluginManifest; enabled: boolean; window: Monitor; config: Record<string, string | number | boolean>; backendEndpoint?: string }
export function pluginSelector(p: PluginInstance) { return p.instance_id === undefined ? {plugin_id:p.manifest.id} : {plugin_id:p.manifest.id,instance_id:p.instance_id}; }
export function selectPlugin(plugins: PluginInstance[], op: Record<string,any>) {
 if(op.plugin_id===undefined&&op.instance_id===undefined)throw Error('Provide plugin_id or instance_id');
 const matches=plugins.filter(p=>op.instance_id!==undefined?p.instance_id===op.instance_id:p.instance_id===undefined&&p.manifest.id===op.plugin_id);
 if(matches.length!==1||op.plugin_id!==undefined&&matches[0].manifest.id!==op.plugin_id)throw Error('Unknown or ambiguous plugin instance');
 return matches[0];
}
export function validateBackendEndpoint(value: unknown): string {
 if(typeof value!=='string')throw Error('Backend endpoint must be an HTTPS origin');
 const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Backend endpoint must be an HTTPS origin without credentials');return u.origin;
}
export function validateManifest(m: any): PluginManifest {
 if (!m || m.apiVersion !== 1 || typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(m.id) || typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version) || typeof m.title !== 'string' || !m.title.length || m.title.length > 60 || typeof m.entry !== 'string' || !/^\/apps\/[a-z0-9-]+\/[a-zA-Z0-9/_-]+\.html$/.test(m.entry)) throw Error('Invalid plugin manifest: API v1 requires id, version, title and local app HTML entry');
 if (Object.keys(m).some(k=>!['apiVersion','id','version','title','entry','configSchema'].includes(k))) throw Error('Unsupported plugin manifest field');
 if(m.configSchema!==undefined)validatePluginConfigSchema(m.configSchema);
 return m;
}
export function validateConfig(c: any) {
 if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length > 32 || JSON.stringify(c).length > 4096 || Object.entries(c).some(([k,v])=>! /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(k) || !['string','number','boolean'].includes(typeof v) || (typeof v==='number'&&!Number.isFinite(v)))) throw Error('Invalid plugin config');
}
export function validateInstanceConfig(p:PluginInstance,active=p.enabled) {
 const schema=p.manifest.configSchema;
 assertValidPluginConfig(p.config,active?schema:schema&&{fields:schema.fields.map(field=>({...field,required:false}))});
 validateConfig(applyConfigDefaults(p.config,schema));
}
export function pluginUrl(p: PluginInstance) { return p.backendEndpoint ? validateBackendEndpoint(p.backendEndpoint) + '/' : p.manifest.entry + '#orbit-config=' + encodeURIComponent(JSON.stringify(applyConfigDefaults(p.config,p.manifest.configSchema))); }
const canonical=(value:any):string=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export function validatePlugins(value: any) {
 if (value === undefined) return;
 if (!Array.isArray(value) || value.length > 32) throw Error('Maximum 32 installed plugins');
 const ids=new Set();const windows=new Set();const definitions=new Map();
 for (const p of value) {
  if(!p||typeof p!=='object')throw Error('Invalid plugin instance');
  if(p.backendEndpoint!==undefined)validateBackendEndpoint(p.backendEndpoint);validateManifest(p.manifest);validateConfig(p.config);
  if(p.instance_id!==undefined&&(typeof p.instance_id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.instance_id)))throw Error('Invalid instance_id');
  const key=p.instance_id===undefined?'legacy:'+p.manifest.id:'instance:'+p.instance_id;
  if(typeof p.enabled!=='boolean'||!p.window||typeof p.window.id!=='string'||ids.has(key)||windows.has(p.window.id))throw Error('Invalid plugin instance');
  const definition=definitions.get(p.manifest.id);
  if(definition&&canonical(definition)!==canonical(p.manifest))throw Error('Instances must share the same definition manifest');
  validateInstanceConfig(p,false);
  definitions.set(p.manifest.id,p.manifest);ids.add(key);windows.add(p.window.id);
 }
 for(const p of value)if(p.backendEndpoint&&value.filter(q=>q.manifest.id===p.manifest.id).length>1)throw Error('Backend-connected definitions cannot have multiple instances');
}
export function pluginOperation(state: Workspace, op: Record<string,any>) {
 state.plugins ||= [];
 const existing=['plugin_install','plugin_update','plugin_disable_all'].includes(op.action)?undefined:selectPlugin(state.plugins,op);
 const detach=(p:PluginInstance)=> { const win=state.monitors.find(m=>m.id===p.window.id);if(win)p.window=structuredClone(win);state.monitors=state.monitors.filter(m=>m.id!==p.window.id);p.enabled=false; };
 // Schema-11 disabled configure/update operations retained the previous app URL.
 // Recognize that historical shape only for legacy records, never arbitrary
 // remote URLs or another instance's surface. Backend changes already reset a
 // matching old backend URL to the local entry before changing the endpoint.
 const legacyAppUrl=(url:string)=>{
  const match=url.match(/^\/apps\/[a-z0-9-]+\/[a-zA-Z0-9/_-]+\.html(?:#orbit-config=(.+))?$/);
  if(!match)return false;
  if(match[1]!==undefined)try{validateConfig(JSON.parse(decodeURIComponent(match[1])));}catch{return false;}
  return true;
 };
 const surface=(p:PluginInstance, win:Monitor, oldUrl=pluginUrl(p))=>{
  const browsers=leaves(win.layout).filter(pane=>pane.kind==='browser');
  // Prefer known identity over unrelated app/Welcome panes in the same split.
  // Legacy history precedes Welcome so a stale app cannot redirect an unrelated
  // freshly split browser. The final Welcome tier still enables fresh installs.
  const tiers=[
   browsers.filter(pane=>pane.url===oldUrl),
   browsers.filter(pane=>pane.url===p.manifest.entry),
   p.instance_id===undefined?browsers.filter(pane=>legacyAppUrl(pane.url)):[],
   browsers.filter(pane=>pane.url==='orbit://welcome'),
  ];
  for(const matches of tiers){if(matches.length>1)throw Error('Plugin surface is missing or ambiguous');if(matches.length===1)return matches[0];}
  throw Error('Plugin surface is missing or ambiguous');
 };
 const attach=(p:PluginInstance)=> {validateInstanceConfig(p,true);if(state.monitors.some(m=>m.id===p.window.id))return;const win=structuredClone(p.window);surface(p,win).url=pluginUrl(p);state.monitors.push(win);p.window=structuredClone(win);p.enabled=true;state.selected=win.id;};
 switch(op.action){
 case 'plugin_install': {const manifest=structuredClone(validateManifest(op.manifest));if(state.plugins.some(p=>p.manifest.id===manifest.id))throw Error('Plugin already installed; use plugin_update');const config=op.config||{};validateConfig(config);const window=monitor(state.monitors.length+1,'browser');window.name=manifest.title;state.plugins.push({manifest,config,enabled:false,window});break;}
  case 'plugin_backend': {
  if(!existing)throw Error('Unknown plugin');
  if(op.confirm_host_access!==true)throw Error('Explicit trusted backend confirmation required');
   const endpoint=op.endpoint===null?undefined:validateBackendEndpoint(op.endpoint);
   if(endpoint&&state.plugins.filter(p=>p.manifest.id===existing.manifest.id).length>1)throw Error('Backend-connected definitions cannot have multiple instances');
  const oldUrl=pluginUrl(existing),active=existing.enabled;detach(existing);
   surface(existing,existing.window,oldUrl).url=existing.manifest.entry;
  if(endpoint)existing.backendEndpoint=endpoint;else delete existing.backendEndpoint;
  if(active)attach(existing);break;
 }
 case 'plugin_enable': if(!existing)throw Error('Unknown plugin');attach(existing);break;
 case 'plugin_disable': if(!existing)throw Error('Unknown plugin');detach(existing);break;
  case 'plugin_remove': if(!existing)throw Error('Unknown plugin');detach(existing);state.plugins=state.plugins.filter(p=>p!==existing);break;
  case 'plugin_duplicate': {
   if(!existing)throw Error('Unknown plugin');
   if(state.plugins.length>=32)throw Error('Maximum 32 installed plugin instances');
   if(state.plugins.some(p=>p.manifest.id===existing.manifest.id&&p.backendEndpoint))throw Error('Backend-connected plugins cannot be duplicated');
   const source=state.monitors.find(m=>m.id===existing.window.id)||existing.window;
   surface(existing,source);
   const config=structuredClone(existing.config);validateConfig(config);
   if(op.name!==undefined&&(typeof op.name!=='string'||op.name.length>60))throw Error('Invalid duplicate name');
   const fresh=monitor(state.monitors.length+1,'browser');
   const window={...structuredClone(source),id:fresh.id,layout:fresh.layout,name:op.name??`${source.name} copy`.slice(0,60)};
   const copy:PluginInstance={instance_id:id(),manifest:structuredClone(existing.manifest),config,enabled:false,window};
   state.plugins.push(copy);if(existing.enabled)attach(copy);break;
  }
 case 'plugin_patch_config': {
  if(!existing)throw Error('Unknown plugin');validateConfig(op.patch);
  const config={...existing.config,...op.patch};validateConfig(config);
   const oldUrl=pluginUrl(existing),active=existing.enabled;detach(existing);surface(existing,existing.window,oldUrl).url=existing.manifest.entry;existing.config=config;if(active)attach(existing);break;
 }
 case 'plugin_window': {
  if(!existing)throw Error('Unknown plugin');
  const settings=op.settings;if(!settings || typeof settings!=='object' || Array.isArray(settings) || Object.keys(settings).some(k=>!['name','frame','fontSize','spatialFontSize','opacity','diagonal','aspect','height','distance','pitch','yaw','offset'].includes(k)))throw Error('Invalid plugin window settings');
  const active=existing.enabled;detach(existing);Object.assign(existing.window,structuredClone(settings));if(active)attach(existing);break;
 }
  case 'plugin_configure': if(!existing)throw Error('Unknown plugin');validateConfig(op.config);{const oldUrl=pluginUrl(existing),active=existing.enabled;detach(existing);surface(existing,existing.window,oldUrl).url=existing.manifest.entry;existing.config=structuredClone(op.config);if(active)attach(existing);}break;
  case 'plugin_update': {
   if(op.instance_id!==undefined)throw Error('Manifest updates are definition-wide; provide plugin_id');
   const matches=state.plugins.filter(p=>p.manifest.id===op.plugin_id);if(!matches.length)throw Error('Unknown plugin definition');
   const manifest=structuredClone(validateManifest(op.manifest));if(manifest.id!==op.plugin_id)throw Error('Plugin ID cannot change');
   for(const p of matches){const oldUrl=pluginUrl(p),active=p.enabled;detach(p);const pane=surface(p,p.window,oldUrl);p.manifest=structuredClone(manifest);pane.url=p.manifest.entry;if(active)attach(p);}break;
  }
 case 'plugin_disable_all': for(const p of state.plugins)detach(p);break;
 default:throw Error('Unknown plugin action');
 }
}
