// Inert tables kept per Kyle's Phase 3 decision, never read or written.
// The Project Workbench server was removed in cleanup Phase 3; these schema
// constants remain only so existing stores still open and fresh stores are
// created with the exact same sqlite user_version and tables.
export const workbenchSchemaSql=`
CREATE TABLE IF NOT EXISTS wb_projects(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), root TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(workspace_id,root));
CREATE TABLE IF NOT EXISTS wb_resources(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES wb_projects(id), locator TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(project_id,locator));
CREATE TABLE IF NOT EXISTS wb_bindings(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES wb_projects(id), resource_id TEXT NOT NULL REFERENCES wb_resources(id), pane_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(workspace_id,pane_id,role));
`;
export const WORKBENCH_RECORD_KINDS=Object.freeze(['tasks','attempts','contexts','disclosures','submissions','candidates','jobs','evidence','reviews','grants','toolcalls','profiles','integrations','annotations','results','cards','patches','proposals','recipes']);
const recordTableSql=kind=>`
CREATE TABLE IF NOT EXISTS wb_${kind}(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES wb_projects(id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
    CHECK(json_extract(record_json,'$.version')=1)
    CHECK(json_extract(record_json,'$.id')=id)
    CHECK(json_extract(record_json,'$.workspace_id')=workspace_id)
    CHECK(json_extract(record_json,'$.project_id')=project_id)
    CHECK(json_extract(record_json,'$.revision')=revision)
);
CREATE INDEX IF NOT EXISTS wb_${kind}_project ON wb_${kind}(workspace_id,project_id);
`;
// Schema 6 must stay frozen: proposals/recipes are created by the additive
// schema-9 migration, not while upgrading a legacy schema-5 database.
export const workbenchExecutionSchemaSql=WORKBENCH_RECORD_KINDS.filter(kind=>!['results','cards','patches','proposals','recipes'].includes(kind)).map(recordTableSql).join('\n');
export const workbenchOperationSchemaSql=`
CREATE UNIQUE INDEX IF NOT EXISTS wb_jobs_operation_identity
ON wb_jobs(workspace_id,project_id,json_extract(record_json,'$.op_id'))
WHERE json_extract(record_json,'$.op_id') IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wb_integrations_operation_identity
ON wb_integrations(workspace_id,project_id,json_extract(record_json,'$.op_id'))
WHERE json_extract(record_json,'$.op_id') IS NOT NULL;
`;
export const workbenchResultSchemaSql=`
${['results','cards','patches'].map(recordTableSql).join('\n')}
CREATE UNIQUE INDEX IF NOT EXISTS wb_results_run ON wb_results(workspace_id,project_id,json_extract(record_json,'$.run_id'));
CREATE UNIQUE INDEX IF NOT EXISTS wb_cards_operation ON wb_cards(workspace_id,project_id,json_extract(record_json,'$.op_id'));
CREATE UNIQUE INDEX IF NOT EXISTS wb_patches_operation ON wb_patches(workspace_id,project_id,json_extract(record_json,'$.op_id')) WHERE json_extract(record_json,'$.op_id') IS NOT NULL;
`;
// Additive schema 9: durable arrangement proposals, portable saved recipes and
// append-only recipe-save operation receipts. The proposal operation index is
// created separately after a duplicate guard so a conflicted old copy fails
// migration instead of silently dropping a receipt.
export const workbenchProposalSchemaSql=`${['proposals','recipes'].map(recordTableSql).join('\n')}
CREATE TABLE IF NOT EXISTS wb_recipe_receipts(
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor TEXT NOT NULL,
  op_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  intent TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,actor,op_id)
);
CREATE INDEX IF NOT EXISTS wb_recipe_receipts_workspace ON wb_recipe_receipts(workspace_id);
`;
export const workbenchProposalIndexSql=`CREATE UNIQUE INDEX IF NOT EXISTS wb_proposals_operation ON wb_proposals(workspace_id,project_id,json_extract(record_json,'$.op_id'),json_extract(record_json,'$.committed_actor')) WHERE json_extract(record_json,'$.op_id') IS NOT NULL AND json_extract(record_json,'$.committed_actor') IS NOT NULL;`;

// Additive schema 10. Tool definitions/releases, placement bindings, grants and
// private application data have independent lifetimes. None is layout-v1 state.
// Notebook text belongs only in wb_tool_data; mutation receipts are metadata-only.
export const projectToolsSchemaSql = `
CREATE TABLE IF NOT EXISTS wb_tool_definitions(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
);
CREATE INDEX IF NOT EXISTS wb_tool_definitions_workspace ON wb_tool_definitions(workspace_id);
CREATE TABLE IF NOT EXISTS wb_tool_releases(
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES wb_tool_definitions(id),
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
);
CREATE UNIQUE INDEX IF NOT EXISTS wb_tool_releases_version ON wb_tool_releases(definition_id,json_extract(record_json,'$.release'));
CREATE TABLE IF NOT EXISTS wb_tool_instances(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES wb_projects(id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
    CHECK(json_extract(record_json,'$.id')=id)
    CHECK(json_extract(record_json,'$.workspace_id')=workspace_id)
    CHECK(json_extract(record_json,'$.project_id')=project_id)
    CHECK(json_extract(record_json,'$.revision')=revision)
);
CREATE INDEX IF NOT EXISTS wb_tool_instances_project ON wb_tool_instances(workspace_id,project_id);
CREATE TABLE IF NOT EXISTS wb_tool_grants(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES wb_projects(id),
  instance_id TEXT NOT NULL UNIQUE REFERENCES wb_tool_instances(id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
    CHECK(json_extract(record_json,'$.version') IS 1)
    CHECK(json_extract(record_json,'$.id') IS id)
    CHECK(json_extract(record_json,'$.workspace_id') IS workspace_id)
    CHECK(json_extract(record_json,'$.project_id') IS project_id)
    CHECK(json_extract(record_json,'$.instance_id') IS instance_id)
    CHECK(json_extract(record_json,'$.revision') IS revision)
);
CREATE INDEX IF NOT EXISTS wb_tool_grants_project ON wb_tool_grants(workspace_id,project_id);
CREATE TABLE IF NOT EXISTS wb_tool_bindings(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES wb_projects(id),
  instance_id TEXT NOT NULL REFERENCES wb_tool_instances(id),
  pane_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id,pane_id)
);
CREATE INDEX IF NOT EXISTS wb_tool_bindings_instance ON wb_tool_bindings(instance_id);
CREATE TABLE IF NOT EXISTS wb_tool_data(
  instance_id TEXT PRIMARY KEY REFERENCES wb_tool_instances(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES wb_projects(id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
);
CREATE TABLE IF NOT EXISTS wb_tool_receipts(
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor TEXT NOT NULL,
  op_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  intent TEXT NOT NULL,
  kind TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  policy_generation INTEGER NOT NULL DEFAULT 0 CHECK(policy_generation>=0),
  created INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,actor,op_id)
);
CREATE TABLE IF NOT EXISTS wb_tool_proposals(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES wb_projects(id),
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
);
CREATE INDEX IF NOT EXISTS wb_tool_proposals_workspace ON wb_tool_proposals(workspace_id);
`;
