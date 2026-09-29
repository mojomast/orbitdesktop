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
