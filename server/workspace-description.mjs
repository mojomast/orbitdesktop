import {contract} from '../contracts/workspace-v1.mjs';
import {featureCapabilities} from '../contracts/feature-capabilities.mjs';

function operationCatalog(name) {
  if(typeof name!=='string'||!Object.hasOwn(contract.operations,name))throw Object.assign(Error('Unknown catalog operation'),{category:'INVALID_OPERATION'});
  const operation=contract.operations[name],referenced=new Set();
  const visit=value=>{
    if(Array.isArray(value)){for(const item of value)visit(item);return;}
    if(!value||typeof value!=='object')return;
    const match=typeof value.$ref==='string'&&/^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(value.$ref);
    if(match&&!referenced.has(match[1])){
      referenced.add(match[1]);
      visit(contract.schema.$defs[match[1]]);
    }
    for(const [key,item] of Object.entries(value))if(key!=='$ref')visit(item);
  };
  visit(operation);
  return {version:contract.version,limits:contract.limits,operation:{name,...operation},
    $defs:Object.fromEntries(Object.entries(contract.schema.$defs).filter(([key])=>referenced.has(key)))};
}

// Authenticated layout metadata only. A role never confers access to its resource.
// The operation catalog comes from the same trusted contract as server validation.
export function describeWorkspace(store, body, capabilities=featureCapabilities()) {
  const workspace=store.read(body.workspace_id);
  const surfaces=[];
  for(const window of workspace.state.monitors){
    const visit=node=>{
      if(node.type==='pane')surfaces.push({window_id:window.id,pane_id:node.pane.id,kind:node.pane.kind});
      else {visit(node.first);visit(node.second);}
    };
    visit(window.layout);
  }
  if(surfaces.length>1000)throw Object.assign(Error('Description exceeds bounded metadata budget'),{category:'REQUEST_TOO_LARGE'});
  return {version:1,workspace_id:workspace.id,revision:workspace.revision,
    capabilities,
    editable_fields:Object.keys(contract.schema.$defs.workspace.properties).filter(key=>key!=='version'),surfaces,
    projects:[],bindings:[],
    extension_compatibility:{manifest_api:1,multiple_instances:true,private_frame_data:false,network:'legacy-network-capable'},
    unsupported:['Roles do not authorize resource reads','Private application data is not exposed to generated frames','Browser acknowledgement is not visual verification'],
    ...(body.catalog_operation!==undefined?{catalog:operationCatalog(body.catalog_operation)}:body.catalog?{catalog:{version:contract.version,limits:contract.limits,operations:Object.keys(contract.operations).sort()}}:{}),
  };
}

// Keep a parseable envelope, omitting whole records rather than slicing JSON.
export function boundedWorkspaceContext(snapshot,maxBytes=24000) {
  const original=JSON.stringify(snapshot);
  if(Buffer.byteLength(original)<=maxBytes)return original;
  const state=snapshot.state??{}, monitors=state.monitors??[];
  const envelope={workspace_id:snapshot.id??snapshot.workspace_id,revision:snapshot.revision,truncated:true,counts:{windows:monitors.length},discovery:{tool:'orbit_workspace',action:'describe'},windows:[]};
  for(const window of monitors){
    const item={id:window.id};
    envelope.windows.push(item);
    if(Buffer.byteLength(JSON.stringify(envelope))>maxBytes){envelope.windows.pop();break;}
  }
  return JSON.stringify(envelope);
}
