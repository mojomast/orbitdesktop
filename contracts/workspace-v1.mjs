// Trusted, versioned JSON Schema source. Never load validator code from apps/models.
// Generated adapters and reference files are checked by --check in CI.
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = (maxLength = 2048) => ({ type: 'string', maxLength });
const num = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const integer = (minimum, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum });
const enumeration = (...values) => ({ enum: values });
const bool = { type: 'boolean' };
const ref = name => ({ $ref: `#/$defs/${name}` });
const array = (items, extra = {}) => ({ type: 'array', items, ...extra });
const identifier = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' };
const kind = enumeration('terminal', 'browser', 'agent');
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const appearance = {
  theme: enumeration('midnight', 'xp', 'classic', 'paper', 'cyberpunk'),
  ...Object.fromEntries(['surfaceColor','panelColor','borderColor','mutedColor','titlebarColor','titlebarTextColor','buttonColor','buttonTextColor','background','textColor','accentColor'].map(k => [k, color])),
  controlRadius: num(0,24), titlebarHeight: num(24,64), uiFont: enumeration('system','classic','mono'),
  wallpaper: { type: 'string', maxLength: 300, pattern: '^(?:|/[a-zA-Z0-9/_-]+\\.(?:svg|png|jpg|jpeg|webp))$' },
  cornerRadius: num(0,40), fullViewport: bool, headerHeight: num(32,80), sidebarWidth: num(200,480),
  workspaceGap: num(0,32), navigationPosition: enumeration('top','bottom'), wallpaperFit: enumeration('cover','contain','auto'),
};
const settings = {
  name: text(60), diagonal: num(20,Number.MAX_SAFE_INTEGER), aspect: enumeration('16:9','16:10','21:9','32:9','4:3','9:16','1:1'),
  height: num(-2,3), distance: num(-2,4), pitch: num(-35,35), yaw: num(-45,45), offset: num(-3,3),
  fontSize: num(6,32), spatialFontSize: num(6,96), opacity: num(0.2,1), frame: ref('frame'),
};
const defs = {
  frame: object({ x:num(0,10000), y:num(0,10000), width:num(280,4000), height:num(180,4000), z:num(0,100000) }),
  spatial: object({ x:num(-10000,10000), y:num(-10000,10000), z:num(-10000,10000), width:num(0.3,200), height:num(0.3,200), yaw:num(-360,360), pitch:num(-89,89), resolution:enumeration(1280,1920,2560,3840) }),
  camera: object({ x:num(-10000,10000), y:num(-10000,10000), z:num(-10000,10000), azimuth:num(-Math.PI*2,Math.PI*2), elevation:num(-1.5,1.5), distance:num(0.2,2000) }),
  // Docking placement adjunct: a versioned, Windows/docking-only projection of
  // transient Dockview placement. It references stable v1 window ids only and is
  // never part of `record.state`, never carries runtime handles/params and never
  // changes v1 pane identity. Unknown/extra fields and non-finite geometry are
  // rejected by the schema; semantic bounds/duplicates/stale ids are checked by
  // src/docking-placement.ts on both client and server.
  placementFrame: object({ x:num(0,10000), y:num(0,10000), width:num(80,10000), height:num(60,10000) }),
  placementGroup: object({ type:{const:'group'}, windows:array(identifier,{minItems:1,maxItems:100,uniqueItems:true}), active:identifier }, ['type','windows']),
  placementBranch: object({ type:{const:'branch'}, direction:enumeration('horizontal','vertical'), ratio:num(0.05,0.95), first:ref('placementNode'), second:ref('placementNode') }),
  placementFloat: object({ windows:array(identifier,{minItems:1,maxItems:100,uniqueItems:true}), frame:ref('placementFrame'), active:identifier }, ['windows','frame']),
  appearance: object(appearance, []),
  layout: { oneOf: [object({type:{const:'pane'},pane:object({id:identifier,kind,url:text()})}),object({type:{const:'split'},axis:enumeration('row','column'),ratio:num(0.15,0.85),first:ref('layout'),second:ref('layout')})] },
  template: { oneOf: [object({pane_id:identifier}),object({axis:enumeration('row','column'),ratio:num(0.15,0.85),first:ref('template'),second:ref('template')})] },
  monitor: object({id:identifier,...settings,spatial:ref('spatial'),layout:ref('layout')}, ['id','name','diagonal','aspect','height','distance','pitch','yaw','offset','fontSize','layout']),
  manifest: object({apiVersion:{const:1},id:{type:'string',pattern:'^[a-z][a-z0-9-]{0,47}$'},version:{type:'string',pattern:'^\\d+\\.\\d+\\.\\d+$'},title:{...text(60),minLength:1},entry:{type:'string',pattern:'^/apps/[a-z0-9-]+/[a-zA-Z0-9/_-]+\\.html$'}}),
  config: {type:'object',maxProperties:32,propertyNames:{pattern:'^[a-zA-Z][a-zA-Z0-9_-]{0,47}$'},additionalProperties:{anyOf:[text(4096),{type:'number'},bool]}},
  plugin: object({manifest:ref('manifest'),enabled:bool,window:ref('monitor'),config:ref('config'),backendEndpoint:text()},['manifest','enabled','window','config']),
  workspace: object({version:{const:1},monitors:array(ref('monitor'),{minItems:1}),selected:identifier,arc:num(0,30),view:enumeration('windows','spatial'),sidebarHidden:bool,appearance:ref('appearance'),plugins:array(ref('plugin'),{maxItems:32}),spatialCamera:ref('camera')},['version','monitors','selected','arc']),
  placementNode: { oneOf: [ref('placementGroup'), ref('placementBranch')] },
  dockingPlacement: object({version:{const:1},layout:{anyOf:[ref('placementNode'),{type:'null'}]},floats:array(ref('placementFloat'),{maxItems:100}),active:{anyOf:[identifier,{type:'null'}]}},['version','layout','floats']),
};
const window = { window_id: identifier }, pane = {...window,pane_id:identifier}, plugin = {plugin_id:ref('manifestId')};
defs.manifestId = defs.manifest.properties.id;
const operations = {};
function op(name, properties = {}, required = Object.keys(properties), effect = 'layout') {
  operations[name] = {input:object({action:{const:name},...properties},['action',...required]),sideEffect:effect,permission:effect==='trusted-backend'?'owner-host-code-confirmation':'workspace-write',revision:'current-base-revision',idempotency:'not-retry-safe-without-durable-receipt'};
}
op('set_spatial_camera',{camera:ref('camera')});
op('arrange_spatial',{window_ids:array(identifier,{minItems:1,uniqueItems:true}),mode:enumeration('grid','row','curve'),columns:integer(1),gap:num(0,20)},[]);
op('reset_appearance',{keys:array(enumeration(...Object.keys(appearance)))});
op('set_arc',{arc:num(0,30)});
op('reorder_windows',{window_ids:array(identifier,{minItems:1,uniqueItems:true})});
op('swap_panes',{...pane,other_window_id:identifier,other_pane_id:identifier});
op('layout_panes',{...window,layout:ref('template')});
op('arrange_windows',{width:num(280,16000),height:num(180,16000),window_ids:array(identifier,{minItems:1,uniqueItems:true}),columns:integer(1),gap:num(0,100)},['width','height']);
op('set_workspace',{state:ref('workspace')});
op('patch_appearance',{patch:ref('appearance')});
op('set_appearance',{appearance:ref('appearance')});
op('update_split',{...window,path:array(enumeration('first','second'),{maxItems:8}),ratio:num(0.15,0.85),axis:enumeration('row','column'),swap:bool},['window_id','path']);
op('set_view',{view:enumeration('windows','spatial')});
op('sidebar',{hidden:bool});
op('select',window);
op('add_window',{name:text(60),kind,url:text(),frame:ref('frame')},[]);
op('update_window',{...window,...settings,spatial:ref('spatial')},['window_id']);
op('close_window',window);
op('set_pane',{...pane,kind,url:text()},['window_id','pane_id']);
op('split_pane',{...pane,kind,axis:enumeration('row','column'),ratio:num(0.15,0.85)},['window_id','pane_id']);
op('close_pane',pane);
op('plugin_install',{manifest:ref('manifest'),config:ref('config')},['manifest'],'plugin-registration');
op('plugin_backend',{...plugin,endpoint:{anyOf:[text(),{type:'null'}]},confirm_host_access:{const:true}},undefined,'trusted-backend');
for (const name of ['enable','disable','remove']) op(`plugin_${name}`,plugin,undefined,'plugin-registration');
op('plugin_patch_config',{...plugin,patch:ref('config')},undefined,'plugin-registration');
op('plugin_window',{...plugin,settings:object(settings,[])},undefined,'plugin-registration');
op('plugin_configure',{...plugin,config:ref('config')},undefined,'plugin-registration');
op('plugin_update',{...plugin,manifest:ref('manifest')},undefined,'plugin-registration');
op('plugin_disable_all',{},[],'plugin-registration');
defs.operation = {oneOf:Object.values(operations).map(op=>op.input)};
const limits = {maxOperations:32,maxRequestBytes:150000,maxResponseBytes:2000000,maxLabelCharacters:120};
const commands = {};
function command(name, properties = {}, required = [], effect = 'read', revision = 'none') {
  commands[name] = {input:object({workspace_id:uuid,action:{const:name},...properties},['workspace_id','action',...required]),output:effect==='read'?'metadata-or-snapshot':'committed-snapshot',sideEffect:effect,permission:'authenticated-workspace',revision,idempotency:effect==='read'?'read-only':'legacy-no-durable-receipt'};
}
command('read',{observed_revision:integer(0)});
command('history');
command('checkpoint',{label:text(limits.maxLabelCharacters)},[],'checkpoint');
command('placement_save',{base_revision:integer(0),placement:ref('dockingPlacement'),operation_id:{type:'string',pattern:'^[a-zA-Z0-9_.:-]{1,128}$'},intent:{type:'string',minLength:1,maxLength:160}},['base_revision','placement','operation_id','intent'],'layout','current-base-revision');
command('restore',{base_revision:integer(0),checkpoint_id:uuid,confirm:bool},['base_revision','checkpoint_id'],'layout','current-base-revision');
command('recovery_policy',{base_revision:integer(0),operation_id:{type:'string',pattern:'^[a-zA-Z0-9_.:-]{1,128}$'},intent:{type:'string',minLength:1,maxLength:160},confirm:{const:true},held:bool},['base_revision','operation_id','intent','confirm','held'],'recovery-policy','current-base-revision');
const batch={base_revision:integer(0),operations:array(ref('operation'),{minItems:1,maxItems:limits.maxOperations})};
command('apply',batch,Object.keys(batch),'layout','current-base-revision');
command('preview',batch,Object.keys(batch),'read','current-base-revision');
command('plugins_apply',batch,Object.keys(batch),'plugin-registration','current-base-revision');
command('sync',{state:ref('workspace'),base_revision:integer(0),observed_revision:integer(0)},['state'],'layout','required-after-initial-connect');
command('shelf');
command('jev_suggest',{request:text(12000),api_key:text(4096),consent:bool},['request','api_key','consent'],'external-model-request');
command('jev_apply',{action_id:text(100),base_revision:integer(0),confirm:bool},['action_id','base_revision'],'layout','current-base-revision');
// Ordinary browser polling persists last-seen/observed metadata, unlike control
// and recovery reads. Do not describe all routes as side-effect-free reads.
commands.read.sideEffect = 'route-dependent-client-observation';
commands.read.routeEffects = {browser:'client-observation-write',control:'read',recovery:'read'};
commands.read.idempotency = 'read-only-on-control-and-recovery; browser-overwrites-observation';
commands.jev_suggest.permission = 'authenticated-owner-with-external-data-consent';
commands.jev_suggest.idempotency = 'external-provider-request-not-retry-safe';
commands.recovery_policy.permission = 'authenticated-owner-on-recovery-route-only';
commands.recovery_policy.idempotency = 'durable receipt scoped to recovery policy generation; obsolete generation replay rejected';
defs.recoveryPolicy=object({held:bool,generation:integer(0)});
defs.snapshot = object({workspace_id:uuid,revision:integer(1),state:ref('workspace'),observed_revision:integer(0),browser_seen:{anyOf:[{type:'number'},{type:'null'}]},app_versions:{type:'object',additionalProperties:{type:'number'}},recovery_policy:ref('recoveryPolicy'),placement:ref('dockingPlacement'),placement_revision:integer(0)},['workspace_id','revision','state','observed_revision','browser_seen']);
defs.placementSnapshot = object({workspace_id:uuid,revision:integer(1),placement_revision:integer(0),placement:ref('dockingPlacement'),observed_revision:integer(0),browser_seen:{anyOf:[{type:'number'},{type:'null'}]},recovery_policy:ref('recoveryPolicy'),command_receipt:ref('commandReceipt')},['workspace_id','revision','placement_revision','placement','command_receipt']);
defs.checkpointMetadata = object({id:uuid,created:{type:'number'},label:text(160),revision:integer(1)});
const outputs = {
  read:ref('snapshot'),sync:ref('snapshot'),apply:ref('snapshot'),plugins_apply:ref('snapshot'),restore:ref('snapshot'),jev_apply:ref('snapshot'),recovery_policy:ref('snapshot'),
  placement_save:ref('placementSnapshot'),
  checkpoint:object({checkpoint:uuid}),
  history:object({revision:integer(1),checkpoints:array(ref('checkpointMetadata'))}),
  preview:object({workspace_id:uuid,base_revision:integer(1),preview:{const:true},state:ref('workspace'),changed_fields:array(text(100)),warning:text()}),
  shelf:object({items:array(object({title:text(),url:text(),kind:enumeration('app/report','output')}),{maxItems:300})}),
};
defs.commandReceipt=object({operation_id:{type:'string',pattern:'^[a-zA-Z0-9_.:-]{1,128}$'},legacy:bool});
defs.snapshot.properties.command_receipt=ref('commandReceipt');
outputs.checkpoint.properties.command_receipt=ref('commandReceipt');
outputs.checkpoint.required.push('command_receipt');
defs.committedSnapshot=structuredClone(defs.snapshot);
defs.committedSnapshot.required.push('command_receipt');
for(const action of ['sync','apply','plugins_apply','restore','jev_apply','recovery_policy'])outputs[action]=ref('committedSnapshot');
for(const name of ['sync','apply','plugins_apply','restore','checkpoint','jev_apply']) {
  const command=commands[name];
  Object.assign(command.input.properties,{
    operation_id:{type:'string',pattern:'^[a-zA-Z0-9_.:-]{1,128}$'},
    intent:{type:'string',minLength:1,maxLength:160},
    base_revision:integer(0),
  });
  command.input.dependencies={operation_id:['intent','base_revision'],intent:['operation_id']};
  command.idempotency='durable receipt by authenticated actor/workspace/operation_id within recovery policy generation; obsolete generation replay rejected; legacy missing keys are not retry-safe';
}
for(const operation of Object.values(operations))operation.idempotency='receipt belongs to containing command batch';
for(const [name,command] of Object.entries(commands)) {
  command.output = outputs[name] || {type:'object',description:'Legacy optional Jev result; provider output validation remains in server/jev.mjs'};
}
export const contract = {
  version:1,limits,errors:{INVALID_OPERATION:'Request does not match the workspace contract',REVISION_CONFLICT:'Workspace changed; read and reconsider',IDEMPOTENCY_CONFLICT:'Operation key was already used with a different request',RECOVERY_HOLD:'Recovery hold prevents active registered plugins',RECOVERY_POLICY_CHANGED:'Recovery policy generation changed since receipt',RESOURCE_BUSY:'Workspace store is busy; retry only with the same operation key and payload',STORE_UNAVAILABLE:'Workspace store unavailable',MIGRATION_REQUIRED:'Explicit legacy store migration required',PERMISSION_REQUIRED:'Workspace authentication required',RESOURCE_GONE:'Workspace or resource unavailable',UPGRADE_REQUIRED:'Client cannot write this workspace version',REQUEST_TOO_LARGE:'Workspace request exceeds the byte budget'},
  operations,commands,
  schema:{$schema:'http://json-schema.org/draft-07/schema#',$id:'urn:orbit:workspace-command:1',$defs:defs,oneOf:Object.values(commands).map(command=>command.input)},
};
contract.errors.BUNDLE_UNAVAILABLE='Published bundle is missing, changed or unindexed; verify files and refresh the bundle index';
