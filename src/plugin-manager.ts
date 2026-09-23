import { el, button } from './dom';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';
import { validateManifest, type PluginInstance, type PluginManifest } from './plugins';
import './plugin-manager.css';
type CatalogEntry = {manifest: PluginManifest; category: string; description: string; provenance?: {repo: string; sha: string; maintainer: string; license: string; capabilities: {network: boolean; storage: boolean}}};
export function showPlugins(token:()=>string){
 const dialog=el('dialog','hermes-tools-dialog orbit-plugin-manager');dialog.setAttribute('aria-label','Workspace plugins');
 const status=el('p','plugin-status'),list=el('div','plugin-grid'),summary=el('p','plugin-summary');status.setAttribute('role','status');
 const search=el('input');search.type='search';search.placeholder='Search desktop plugins…';search.setAttribute('aria-label','Search desktop plugins');
 const filter=el('select');filter.setAttribute('aria-label','Plugin status filter');
 for(const name of ['All plugins','Installed','Enabled','Disabled','Not installed']){const option=el('option','',name);option.value=name;filter.append(option);}
 let revision=0,busy=false,installed:PluginInstance[]=[],activeIds=new Set<string>(),catalog:CatalogEntry[]=[],monitors:any[]=[];
 async function api(body:Record<string,unknown>){const r=await fetch('/api/workspace',{method:'POST',headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:workspaceId,...body})});const data=await r.json();if(!r.ok)throw Error(data.error||'Plugin request failed');return data;}
 async function change(operations:Record<string,unknown>[]){if(busy)return;busy=true;render();try{await api({action:'plugins_apply',base_revision:revision,operations});status.textContent='Saved with a checkpoint. Connected workspace will update automatically.';await load();}catch(e){status.textContent=`${String(e)}. Refresh before retrying; no automatic overwrite.`;}finally{busy=false;render();}}
 function action(label:string,name:string,fn:()=>void){const b=button(label,name,fn);b.disabled=busy;return b;}
 function render(){
  list.replaceChildren();const entries=new Map(catalog.map(c=>[c.manifest.id,c]));
  for(const p of installed)if(!entries.has(p.manifest.id))entries.set(p.manifest.id,{manifest:p.manifest,category:'Workspace tools',description:'Installed in this workspace; not listed in the bundled catalog.'});
  summary.textContent=`${entries.size} plugins · ${installed.length} installed · ${activeIds.size} enabled`;
  const query=search.value.trim().toLowerCase();let count=0;
  for(const entry of [...entries.values()].sort((a,b)=>a.manifest.title.localeCompare(b.manifest.title))){
   const p=installed.find(p=>p.manifest.id===entry.manifest.id),active=activeIds.has(entry.manifest.id),m=p?.manifest||entry.manifest;
   if(query&&!`${m.title} ${m.id} ${entry.category} ${entry.description}`.toLowerCase().includes(query))continue;
   if(filter.value==='Installed'&&!p||filter.value==='Enabled'&&!active||filter.value==='Disabled'&&(!p||active)||filter.value==='Not installed'&&p)continue;
   count++;const row=el('section','plugin-card');row.dataset.pluginId=m.id;
   row.append(el('span','plugin-badge',p?(active?'Enabled':'Disabled'):'Not installed'),el('h3','',m.title),el('p','plugin-meta',`${entry.category} · v${m.version}`),el('p','',entry.description));
   const details=el('details');details.append(el('summary','','Package details'),el('pre','',JSON.stringify({manifest:m,...(entry.provenance?{catalogSource:entry.provenance}:{})},null,2)));row.append(details);
   if(entry.provenance)row.append(el('p','plugin-meta',`GitHub catalog · ${entry.provenance.maintainer} · ${entry.provenance.sha.slice(0,12)} · ${entry.provenance.license}`));
   const actions=el('div','plugin-actions');
   if(!p){actions.append(action('Install',`Install plugin ${m.id}`,()=>void change([{action:'plugin_install',manifest:m}])));}
   else{
    if(entry.provenance&&(p.manifest.entry!==entry.manifest.entry||p.manifest.version!==entry.manifest.version))actions.append(action(`Use catalog v${entry.manifest.version}`,`Update plugin ${m.id}`,()=>{if(window.confirm('Replace this app with the catalog pin? Review the package details first. This may reload an enabled app; unsaved app state can be lost. A checkpoint retains the old manifest.'))void change([{action:'plugin_update',plugin_id:m.id,manifest:entry.manifest}]);}));
    actions.append(action(active?'Disable':'Enable',`${active?'Disable':'Enable'} plugin ${m.id}`,()=>void change([{action:active?'plugin_disable':'plugin_enable',plugin_id:m.id}])));
    actions.append(action('Configure',`Configure plugin ${m.id}`,()=>{const text=window.prompt('Plugin configuration (JSON object; no secrets)',JSON.stringify(p.config));if(text===null)return;try{void change([{action:'plugin_configure',plugin_id:m.id,config:JSON.parse(text)}]);}catch(e){status.textContent=String(e);}}));
    actions.append(action('Window settings',`Customize plugin window ${m.id}`,()=>{const win=monitors.find(w=>w.id===p.window.id)||p.window;const text=window.prompt('Window settings JSON: name, fontSize, frame, opacity, diagonal, aspect, height, distance, pitch, yaw, offset',JSON.stringify({name:win.name,fontSize:win.fontSize}));if(text===null)return;try{void change([{action:'plugin_window',plugin_id:m.id,settings:JSON.parse(text)}]);}catch(e){status.textContent=String(e);}}));
    actions.append(action('Remove',`Remove plugin ${m.id}`,()=>{if(window.confirm('Remove this plugin? A checkpoint is saved; published files are retained.'))void change([{action:'plugin_remove',plugin_id:m.id}]);}));
   }
   row.append(actions);list.append(row);
  }
  if(!count)list.append(el('p','','No matching plugins. Try another search or filter.'));
 }
 async function load(){try{await ensureWorkspaceSynced();const data=await api({action:'read'});revision=data.revision;installed=data.state.plugins||[];monitors=data.state.monitors;activeIds=new Set(installed.filter(p=>monitors.some(m=>m.id===p.window.id)).map(p=>p.manifest.id));render();}catch(e){status.textContent=String(e);}}
 async function loadCatalog(){
  const feeds=await Promise.allSettled(['/orbit-plugin-catalog.json','/orbit-community-catalog.json'].map(async url=>{const r=await fetch(url,{cache:'no-cache'});if(r.status===404)return [];if(!r.ok)throw Error('Catalog unavailable');const data=await r.json();if(data.version!==1||!Array.isArray(data.entries))throw Error('Unsupported catalog');return data.entries.map((c:any)=>{if(c.provenance&&(!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(c.provenance.repo)||typeof c.provenance.sha!=='string'||!/^[a-f0-9]{40}$/.test(c.provenance.sha)||typeof c.provenance.maintainer!=='string'||typeof c.provenance.license!=='string'))throw Error('Invalid catalog provenance');return {manifest:validateManifest(c.manifest),category:String(c.category||'Workspace tools'),description:String(c.description||''),...(c.provenance?{provenance:c.provenance}:{})};});}));
  catalog=feeds.flatMap(feed=>feed.status==='fulfilled'?feed.value:[]);render();
  if(feeds.some(feed=>feed.status==='rejected'))status.textContent='One catalog could not load. Available entries and installed plugins remain manageable.';
 }
 search.addEventListener('input',render);filter.addEventListener('change',render);
 const toolbar=el('div','plugin-toolbar');toolbar.append(search,filter,button('Refresh','Refresh workspace plugins',()=>{void load();void loadCatalog();}));
 const input=el('textarea');input.setAttribute('aria-label','Plugin manifest JSON');input.placeholder='Paste a local API-v1 plugin manifest';
 const advanced=el('details','plugin-advanced');advanced.append(el('summary','','Advanced · install manifest / recovery'),input,button('Install disabled','Install plugin manifest',()=>{try{void change([{action:'plugin_install',manifest:validateManifest(JSON.parse(input.value))}]);}catch(e){status.textContent=String(e);}}),button('Disable all plugins','Disable all workspace plugins',()=>{if(window.confirm('Disable all plugin windows? Core chat and terminals remain.'))void change([{action:'plugin_disable_all'}]);}));
 dialog.append(button('Close','Close workspace plugins',()=>dialog.close()),el('h2','','Orbit Desktop · Plugin Manager'),el('p','','Browse synced GitHub and local catalogs. New community entries arrive after an operator catalog sync. Installs start disabled. Changes are checkpointed; plugins receive no host credentials but may access the network.'),summary,toolbar,status,list,advanced);
 dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();void load();void loadCatalog();
}
