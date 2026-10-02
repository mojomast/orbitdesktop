import { el, button } from './dom';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';
import { workspaceFetch } from './workspace-client';
import { pluginSelector, validateManifest, type PluginInstance, type PluginManifest } from './plugins';
import { showPluginConfigEditor } from './plugin-config-editor';
import { showPluginWindowEditor } from './plugin-window-editor';
import './plugin-manager.css';
import './plugin-config-editor.css';
type CatalogEntry = {manifest: PluginManifest; category: string; description: string; provenance?: {repo: string; sha: string; maintainer: string; license: string; capabilities: {network: boolean; storage: boolean}; backend?: {path: string; runtime: string; permissions: string[]}}};
export function showPlugins(token:()=>string){
 const dialog=el('dialog','hermes-tools-dialog orbit-plugin-manager');dialog.setAttribute('aria-label','Workspace plugins');
 const status=el('p','plugin-status'),list=el('div','plugin-grid'),summary=el('p','plugin-summary');status.setAttribute('role','status');
 const search=el('input');search.type='search';search.placeholder='Search desktop plugins…';search.setAttribute('aria-label','Search desktop plugins');
 const filter=el('select');filter.setAttribute('aria-label','Plugin status filter');
 const source=el('select');source.setAttribute('aria-label','Catalog source');
 for(const name of ['All sources','GitHub community','Local catalog']){const option=el('option','',name);source.append(option);}
 const category=el('select');category.setAttribute('aria-label','Plugin category');
 const allCategories=el('option','','All categories');category.append(allCategories);
 for(const name of ['All plugins','Installed','Enabled','Disabled','Not installed','Updates']){const option=el('option','',name);option.value=name;filter.append(option);}
 let revision=0,busy=false,installed:PluginInstance[]=[],activeIds=new Set<string>(),catalog:CatalogEntry[]=[],monitors:any[]=[];
  async function api(body:Record<string,unknown>){const r=await workspaceFetch(token(),{workspace_id:workspaceId,...body});const data=await r.json();if(!r.ok)throw Error(data.error||'Plugin request failed');return data;}
  async function change(operations:Record<string,unknown>[],options:{propagateErrors?:boolean}={}){if(busy){if(options.propagateErrors)throw Error('Another plugin change is already in progress.');return;}busy=true;render();try{await api({action:'plugins_apply',base_revision:revision,operations,intent:`Manage plugins: ${operations.map(o=>o.action).join(', ')}`});status.textContent='Saved with a checkpoint. Connected workspace will update automatically.';await load();}catch(e){status.textContent=`${String(e)}. Refresh before retrying; no automatic overwrite.`;if(options.propagateErrors)throw e;}finally{busy=false;render();}}
 function action(label:string,name:string,fn:()=>void){const b=button(label,name,fn);b.disabled=busy;return b;}
 function render(){
  list.replaceChildren();const entries=new Map(catalog.map(c=>[c.manifest.id,c]));
  for(const p of installed)if(!entries.has(p.manifest.id))entries.set(p.manifest.id,{manifest:p.manifest,category:'Workspace tools',description:'Installed in this workspace; not listed in the bundled catalog.'});
   summary.textContent=`${entries.size} app definitions · ${installed.length} installed instances · ${activeIds.size} enabled`;
  const query=search.value.trim().toLowerCase();let count=0;
  for(const entry of [...entries.values()].sort((a,b)=>Number(!!b.provenance)-Number(!!a.provenance)||a.manifest.title.localeCompare(b.manifest.title))){
    const instances=installed.filter(p=>p.manifest.id===entry.manifest.id);
    for(const p of instances.length?instances:[undefined]){
    const active=!!p&&activeIds.has(p.window.id),m=p?.manifest||entry.manifest;
    const selector=p?pluginSelector(p):{plugin_id:m.id};
    const label=p?.instance_id?`${m.id} instance ${p.instance_id}`:m.id;
   if(source.value==='GitHub community'&&!entry.provenance||source.value==='Local catalog'&&entry.provenance)continue;
   if(category.value!=='All categories'&&category.value!==entry.category)continue;
   if(filter.value==='Updates'&&(!p||!entry.provenance||(p.manifest.entry===entry.manifest.entry&&p.manifest.version===entry.manifest.version)))continue;
   if(query&&!`${m.title} ${m.id} ${entry.category} ${entry.description}`.toLowerCase().includes(query))continue;
   if(filter.value==='Installed'&&!p||filter.value==='Enabled'&&!active||filter.value==='Disabled'&&(!p||active)||filter.value==='Not installed'&&p)continue;
    count++;const row=el('section','plugin-card');row.dataset.pluginId=m.id;
    if(p?.instance_id)row.dataset.instanceId=p.instance_id;
    row.append(el('span','plugin-badge',p?(active?'Enabled':'Disabled'):'Not installed'),el('h3','',m.title),el('p','plugin-meta',`${entry.category} · v${m.version}`),el('p','',entry.description));
    if(p)row.append(el('p','plugin-meta',`${(monitors.find(w=>w.id===p.window.id)||p.window).name} · ${p.instance_id?`Instance ${p.instance_id}`:'Primary instance'}`));
   const details=el('details');details.append(el('summary','','Package details'),el('pre','',JSON.stringify({manifest:m,...(entry.provenance?{catalogSource:entry.provenance}:{})},null,2)));row.append(details);
   if(entry.provenance){
    const provenance=entry.provenance;
    const link=el('a','plugin-source-link','View pinned source ↗');link.href=`${provenance.repo}/tree/${provenance.sha}`;link.target='_blank';link.rel='noopener noreferrer';
    row.append(el('p','plugin-meta',`GitHub catalog · ${provenance.maintainer} · ${provenance.sha.slice(0,12)} · ${provenance.license}`),link,
     el('p','plugin-capabilities',`Declared capabilities: network ${provenance.capabilities?.network?'yes':'no'} · storage ${provenance.capabilities?.storage?'yes':'no'}. Declarations are not enforced permissions.`));
   }
   const actions=el('div','plugin-actions');
   if(entry.provenance?.backend){
    const setup=el('details','plugin-backend-setup');setup.append(el('summary','','Trusted backend · separate setup required'));
    setup.append(el('p','','This package executes Python with your host account privileges. Declared access is not a sandbox: '+entry.provenance.backend.permissions.join('; ')),el('p','','1. Review pinned source. 2. Stage without execution. 3. Configure private authentication. 4. Explicitly activate and verify health. 5. Connect the endpoint below.'));
    setup.append(el('pre','',`python3 scripts/catalog_backend.py ${m.id}`));
    const guide=el('a','plugin-source-link','Backend setup & recovery ↗');guide.href='https://github.com/mojomast/orbitdesktop/blob/main/docs/CATALOG_BACKENDS.md';guide.target='_blank';guide.rel='noopener noreferrer';setup.append(guide,el('p','','Disable/remove disconnects the UI only. Stop the service separately; checkpoints cannot undo host effects. No automatic backend updates.'));
    row.append(el('p','plugin-capabilities',p?.backendEndpoint?'Endpoint configured · health not checked':'Host integration · backend not connected'),setup);
     if(p)actions.append(action('Connect backend',`Connect backend ${label}`,()=>{const endpoint=window.prompt('Private owner-authenticated HTTPS origin. No passwords/tokens. Leave blank to return to the sandboxed setup UI.',p.backendEndpoint||'');if(endpoint===null)return;if(window.confirm('Trust this external service UI? It runs outside the static app sandbox, but receives no Orbit credentials or host bridge. This only connects a previously deployed service; it does not install or activate host code.'))void change([{action:'plugin_backend',...selector,endpoint:endpoint.trim()||null,confirm_host_access:true}]);}));
   }
   if(!p){actions.append(action('Install',`Install plugin ${m.id}`,()=>void change([{action:'plugin_install',manifest:m}])));}
   else{
     if(entry.provenance&&(p.manifest.entry!==entry.manifest.entry||p.manifest.version!==entry.manifest.version))actions.append(action(`Use catalog v${entry.manifest.version}`,`Update plugin ${m.id}`,()=>{if(window.confirm(`Update all ${instances.length} instances of this app to the catalog pin? Review the package details first. Enabled instances may reload; unsaved app state can be lost. A checkpoint retains the old manifest.`))void change([{action:'plugin_update',plugin_id:m.id,manifest:entry.manifest}]);}));
     actions.append(action(active?'Disable':'Enable',`${active?'Disable':'Enable'} plugin ${label}`,()=>void change([{action:active?'plugin_disable':'plugin_enable',...selector}])));
     actions.append(action('Configure',`Configure plugin ${label}`,()=>showPluginConfigEditor({pluginId:m.id,title:p.instance_id?p.window.name:m.title,config:p.config,schema:p.manifest.configSchema,backendConnected:!!p.backendEndpoint,onApply:operation=>change([{...operation,...selector}],{propagateErrors:true})})));
     actions.append(action('Window settings',`Customize plugin window ${label}`,()=>{const win=monitors.find(w=>w.id===p.window.id)||p.window;showPluginWindowEditor({pluginId:m.id,title:p.instance_id?win.name:m.title,monitor:win,onApply:settings=>change([{action:'plugin_window',...selector,settings}],{propagateErrors:true})});}));
     const duplicate=action('Duplicate',`Duplicate plugin ${label}`,()=>void change([{action:'plugin_duplicate',...selector}]));
     duplicate.disabled=busy||installed.length>=32||!!entry.provenance?.backend||instances.some(instance=>!!instance.backendEndpoint);
     if(duplicate.disabled&&!busy)duplicate.title=installed.length>=32?'Maximum 32 instances':'Backend integrations cannot be duplicated';
     actions.append(duplicate);
     actions.append(action('Remove',`Remove plugin ${label}`,()=>{if(window.confirm('Remove this instance? A checkpoint is saved; published files are retained.'))void change([{action:'plugin_remove',...selector}]);}));
   }
    row.append(actions);list.append(row);
    }
  }
  if(!count)list.append(el('p','','No matching plugins. Try another search or filter.'));
 }
  async function load(){try{await ensureWorkspaceSynced();const data=await api({action:'read'});revision=data.revision;installed=data.state.plugins||[];monitors=data.state.monitors;activeIds=new Set(installed.filter(p=>monitors.some(m=>m.id===p.window.id)).map(p=>p.window.id));render();}catch(e){status.textContent=String(e);}}
 async function loadCatalog(){
  const feeds=await Promise.allSettled(['/orbit-plugin-catalog.json','/orbit-community-catalog.json'].map(async url=>{const r=await fetch(url,{cache:'no-cache'});if(r.status===404)return [];if(!r.ok)throw Error('Catalog unavailable');const data=await r.json();if(data.version!==1||!Array.isArray(data.entries))throw Error('Unsupported catalog');return data.entries.map((c:any)=>{if(c.provenance?.backend&&(!Array.isArray(c.provenance.backend.permissions)||!c.provenance.backend.permissions.length||c.provenance.backend.permissions.length>10||!c.provenance.backend.permissions.every((v:unknown)=>typeof v==='string'&&v.length<=200)||c.provenance.backend.runtime!=='python3'))throw Error('Invalid backend declaration');if(c.provenance&&(!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(c.provenance.repo)||typeof c.provenance.sha!=='string'||!/^[a-f0-9]{40}$/.test(c.provenance.sha)||typeof c.provenance.maintainer!=='string'||typeof c.provenance.license!=='string'))throw Error('Invalid catalog provenance');return {manifest:validateManifest(c.manifest),category:String(c.category||'Workspace tools'),description:String(c.description||''),...(c.provenance?{provenance:c.provenance}:{})};});}));
  catalog=feeds.flatMap(feed=>feed.status==='fulfilled'?feed.value:[]);
  const selectedCategory=category.value;
  category.replaceChildren(el('option','','All categories'),...[...new Set(catalog.map(entry=>entry.category))].sort().map(name=>el('option','',name)));
  category.value=Array.from(category.options).some(option=>option.value===selectedCategory)?selectedCategory:'All categories';
  catalog=feeds.flatMap(feed=>feed.status==='fulfilled'?feed.value:[]);render();
  if(feeds.some(feed=>feed.status==='rejected'))status.textContent='One catalog could not load. Available entries and installed plugins remain manageable.';
 }
 search.addEventListener('input',render);filter.addEventListener('change',render);source.addEventListener('change',render);category.addEventListener('change',render);
 const toolbar=el('div','plugin-toolbar');toolbar.append(search,source,category,filter,button('Refresh','Refresh workspace plugins',()=>{void load();void loadCatalog();}));
 const input=el('textarea');input.setAttribute('aria-label','Plugin manifest JSON');input.placeholder='Paste a local API-v1 plugin manifest';
 const advanced=el('details','plugin-advanced');advanced.append(el('summary','','Advanced · install manifest / recovery'),input,button('Install disabled','Install plugin manifest',()=>{try{void change([{action:'plugin_install',manifest:validateManifest(JSON.parse(input.value))}]);}catch(e){status.textContent=String(e);}}),button('Disable all plugins','Disable all workspace plugins',()=>{if(window.confirm('Disable all plugin windows? Core chat and terminals remain.'))void change([{action:'plugin_disable_all'}]);}));
 const hero=el('header','plugin-hero');
 const contribute=el('a','plugin-contribute','Publish your app ↗');contribute.href='https://github.com/mojomast/orbitdesktop/blob/main/plugin-catalog/README.md';contribute.target='_blank';contribute.rel='noopener noreferrer';
  hero.append(el('span','plugin-eyebrow','ORBIT / APP CATALOG'),el('h2','','Make space for what’s next.'),el('p','','Discover tools that make your workspace yours. Built by people and agents. Shared through GitHub.'),contribute,button('Extension Studio','Open Extension Studio',()=>{void import('./extension-studio').then(({showExtensionStudio})=>{dialog.close();showExtensionStudio(token);}).catch(error=>{status.textContent=String(error);});}));
 dialog.append(button('Close','Close workspace plugins',()=>dialog.close()),hero,el('p','plugin-trust','Commit-pinned community apps · Disabled-first installs · Checkpointed changes'),el('p','plugin-meta','Refresh reads this deployment’s synced catalogs—not GitHub directly. Newly approved entries require an operator catalog sync. Sandboxed apps receive no host credentials; network access is still allowed.'),summary,toolbar,status,list,advanced);
 dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();void load();void loadCatalog();
}
