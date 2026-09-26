import {randomUUID} from 'node:crypto';
export const workbenchSchemaSql=`
CREATE TABLE IF NOT EXISTS wb_projects(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), root TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(workspace_id,root));
CREATE TABLE IF NOT EXISTS wb_resources(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES wb_projects(id), locator TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(project_id,locator));
CREATE TABLE IF NOT EXISTS wb_bindings(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES wb_projects(id), resource_id TEXT NOT NULL REFERENCES wb_resources(id), pane_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(workspace_id,pane_id,role));
`;
export const wbError=code=>Object.assign(Error(code),{code});
export class WorkbenchStore {
  constructor(store){this.store=store;this.db=store.db;}
  list(workspaceId){this.store.read(workspaceId);return this.db.prepare('SELECT record_json FROM wb_projects WHERE workspace_id=? ORDER BY id').all(workspaceId).map(row=>JSON.parse(row.record_json));}
  project(workspaceId,id){const row=this.db.prepare('SELECT record_json FROM wb_projects WHERE id=? AND workspace_id=?').get(id,workspaceId);if(!row)throw wbError('permission_denied');const project=JSON.parse(row.record_json);if(project.active===false)throw wbError('permission_denied');return project;}
  register(workspaceId,{root,name,identity,git_mapping}){
    return this.db.transaction(()=>{
      this.store.read(workspaceId);
      const old=this.db.prepare('SELECT record_json FROM wb_projects WHERE workspace_id=? AND root=?').get(workspaceId,root);
      if(old){const project=JSON.parse(old.record_json);if(project.identity!==identity)throw wbError('stale_resource');const mappingChanged=git_mapping&&JSON.stringify(project.git_mapping)!==JSON.stringify(git_mapping);if(project.active===false||mappingChanged){project.active=true;project.generation++;if(git_mapping)project.git_mapping=git_mapping;this.db.prepare('UPDATE wb_projects SET record_json=? WHERE id=?').run(JSON.stringify(project),project.id);}return project;}
      if(this.list(workspaceId).length>=32)throw wbError('limit_exceeded');
      const project={version:1,id:randomUUID(),workspace_id:workspaceId,root,name,identity,generation:1,created_at:Date.now(),...(git_mapping?{git_mapping}:{})};
      this.db.prepare('INSERT INTO wb_projects VALUES (?,?,?,?)').run(project.id,workspaceId,root,JSON.stringify(project));return project;
    }).immediate();
  }
  resource(projectId,locator,fields){
    const old=this.db.prepare('SELECT record_json FROM wb_resources WHERE project_id=? AND locator=?').get(projectId,locator);
    const previous=old?JSON.parse(old.record_json):null;
    const changed=previous && (previous.kind!==fields.kind || previous.hash!==fields.hash || previous.identity!==fields.identity || previous.state!==fields.state);
    const resource={...fields,version:1,id:previous?.id??randomUUID(),project_id:projectId,generation:(previous?.generation??1)+(changed?1:0)};
    this.db.prepare('INSERT INTO wb_resources VALUES (?,?,?,?) ON CONFLICT(project_id,locator) DO UPDATE SET record_json=excluded.record_json').run(resource.id,projectId,locator,JSON.stringify(resource));return resource;
  }
  getResource(workspaceId,projectId,id){this.project(workspaceId,projectId);const row=this.db.prepare('SELECT record_json FROM wb_resources WHERE id=? AND project_id=?').get(id,projectId);if(!row)throw wbError('permission_denied');return JSON.parse(row.record_json);}
  resources(projectId){return this.db.prepare('SELECT record_json FROM wb_resources WHERE project_id=? ORDER BY id').all(projectId).map(row=>JSON.parse(row.record_json));}
  revoke(workspaceId,id,generation){return this.db.transaction(()=>{const project=this.project(workspaceId,id);if(project.generation!==generation)throw wbError('stale_resource');project.active=false;project.generation++;this.db.prepare('UPDATE wb_projects SET record_json=? WHERE id=?').run(JSON.stringify(project),id);return project;}).immediate();}
  bindings(workspaceId,projectId){this.project(workspaceId,projectId);return this.db.prepare('SELECT * FROM wb_bindings WHERE workspace_id=? AND project_id=? ORDER BY created_at').all(workspaceId,projectId);}
  bind({workspace_id,project_id,resource_id,pane_id,base_revision,role}){
    return this.db.transaction(()=>{
      const workspace=this.store.read(workspace_id);if(workspace.revision!==base_revision)throw wbError('stale_resource');
      const resource=this.getResource(workspace_id,project_id,resource_id);
      const roles={file:['project_files','candidate_diff'],terminal:['active_terminal'],conversation:['primary_agent'],browser:['preview']};
      if(!roles[resource.kind]?.includes(role))throw wbError('unsupported');
      if(resource.pane_id&&resource.pane_id!==pane_id)throw wbError('stale_resource');
      const find=node=>node.type==='pane'?node.pane.id===pane_id:find(node.first)||find(node.second);
      if(!workspace.state.monitors.some(m=>find(m.layout)))throw wbError('stale_resource');
      const existing=this.db.prepare('SELECT * FROM wb_bindings WHERE workspace_id=? AND pane_id=? AND role=?').get(workspace_id,pane_id,role);
      // Binding IDs are immutable CAS tokens. Changing a relationship requires
      // explicitly removing that exact binding, never a silent last-writer win.
      if(existing){if(existing.project_id!==project_id||existing.resource_id!==resource_id)throw wbError('stale_resource');return this.bindings(workspace_id,project_id);}
      const id=randomUUID();this.db.prepare('INSERT INTO wb_bindings VALUES (?,?,?,?,?,?,?)').run(id,workspace_id,project_id,resource_id,pane_id,role,Date.now());
      return this.bindings(workspace_id,project_id);
    }).immediate();
  }
  unbind(workspaceId,projectId,id){return this.db.transaction(()=>{this.project(workspaceId,projectId);const result=this.db.prepare('DELETE FROM wb_bindings WHERE workspace_id=? AND project_id=? AND id=?').run(workspaceId,projectId,id);if(result.changes!==1)throw wbError('stale_resource');return this.bindings(workspaceId,projectId);}).immediate();}
}
