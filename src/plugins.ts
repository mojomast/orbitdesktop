import { monitor, leaves, type Workspace, type Monitor } from './model.ts';
export interface PluginManifest { apiVersion: 1; id: string; version: string; title: string; entry: string }
export interface PluginInstance { manifest: PluginManifest; enabled: boolean; window: Monitor; config: Record<string, string | number | boolean> }
export function validateManifest(m: any): PluginManifest {
 if (!m || m.apiVersion !== 1 || typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(m.id) || typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version) || typeof m.title !== 'string' || !m.title.length || m.title.length > 60 || typeof m.entry !== 'string' || !/^\/apps\/[a-z0-9-]+\/[a-zA-Z0-9/_-]+\.html$/.test(m.entry)) throw Error('Invalid plugin manifest: API v1 requires id, version, title and local app HTML entry');
 if (Object.keys(m).some(k=>!['apiVersion','id','version','title','entry'].includes(k))) throw Error('Unsupported plugin manifest field');
 return m;
}
export function validateConfig(c: any) {
 if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length > 32 || JSON.stringify(c).length > 4096 || Object.entries(c).some(([k,v])=>! /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(k) || !['string','number','boolean'].includes(typeof v) || (typeof v==='number'&&!Number.isFinite(v)))) throw Error('Invalid plugin config');
}
export function pluginUrl(p: PluginInstance) { return p.manifest.entry + '#orbit-config=' + encodeURIComponent(JSON.stringify(p.config)); }
export function validatePlugins(value: any) {
 if (value === undefined) return;
 if (!Array.isArray(value) || value.length > 32) throw Error('Maximum 32 installed plugins');
 const ids=new Set();const windows=new Set();
 for (const p of value) {validateManifest(p.manifest);validateConfig(p.config);if(typeof p.enabled!=='boolean'||!p.window||typeof p.window.id!=='string'||ids.has(p.manifest.id)||windows.has(p.window.id))throw Error('Invalid plugin instance');ids.add(p.manifest.id);windows.add(p.window.id);}
}
export function pluginOperation(state: Workspace, op: Record<string,any>) {
 state.plugins ||= [];
 const existing=state.plugins.find(p=>p.manifest.id===op.plugin_id);
 const detach=(p:PluginInstance)=> { const win=state.monitors.find(m=>m.id===p.window.id);if(win)p.window=structuredClone(win);state.monitors=state.monitors.filter(m=>m.id!==p.window.id);p.enabled=false; };
 const attach=(p:PluginInstance)=> {if(state.monitors.some(m=>m.id===p.window.id))return;const win=structuredClone(p.window);win.name=p.manifest.title;win.layout={type:'pane',pane:{...leaves(p.window.layout)[0],kind:'browser',url:pluginUrl(p)}};state.monitors.push(win);p.window=structuredClone(win);p.enabled=true;state.selected=win.id;};
 switch(op.action){
 case 'plugin_install': {const manifest=structuredClone(validateManifest(op.manifest));if(state.plugins.some(p=>p.manifest.id===manifest.id))throw Error('Plugin already installed; use plugin_update');const config=op.config||{};validateConfig(config);state.plugins.push({manifest,config,enabled:false,window:monitor(state.monitors.length+1,'browser')});break;}
 case 'plugin_enable': if(!existing)throw Error('Unknown plugin');attach(existing);break;
 case 'plugin_disable': if(!existing)throw Error('Unknown plugin');detach(existing);break;
 case 'plugin_remove': if(!existing)throw Error('Unknown plugin');detach(existing);state.plugins=state.plugins.filter(p=>p!==existing);break;
 case 'plugin_configure': if(!existing)throw Error('Unknown plugin');validateConfig(op.config);{const active=existing.enabled;detach(existing);existing.config=structuredClone(op.config);if(active)attach(existing);}break;
 case 'plugin_update': if(!existing)throw Error('Unknown plugin');{const manifest=structuredClone(validateManifest(op.manifest));if(manifest.id!==existing.manifest.id)throw Error('Plugin ID cannot change');const active=existing.enabled;detach(existing);existing.manifest=manifest;if(active)attach(existing);}break;
 case 'plugin_disable_all': for(const p of state.plugins)detach(p);break;
 default:throw Error('Unknown plugin action');
 }
}
