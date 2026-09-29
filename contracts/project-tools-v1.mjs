// Owner-facing project tool requests (v1).
//
// These requests are served only on the owner-authenticated
// `/api/workbench/tools` route (implemented by the lead-owned routing layer).
// They describe a *finite, host-rendered* project surface: a private notebook
// with independently revisioned plain text, or a read-only recorded-evidence
// card over existing Workbench facts. No generated frame, plugin bridge,
// capability grant, model access or public data path is implied.
//
// IDs (workspace/project/instance/pane UUIDs) are selectors, never authorizers.
// Every action carries `workspace_id`; no caller-supplied root, path, secret,
// note body or model payload is accepted outside the explicit bounded fields.
//
// Frozen for the M3 milestone. Do not widen field sets or add actions without a
// new frozen contract; the server validator is compiled from this exact object.

export const TOOL_KINDS = Object.freeze(['notebook', 'evidence_checks']);

export const TOOL_LIMITS = Object.freeze({
  maxDefinitions: 16,
  maxReleases: 8,
  maxInstances: 64,
  maxConfigBytes: 4096,
  maxDataBytes: 262144,
  maxProposals: 200,
  maxReceipts: 1024,
  previewTtlMs: 60000,
  checksMax: 32,
  titleMax: 60,
  configFontMin: 12,
  configFontMax: 28,
});

const uuid = {type: 'string', pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const hash = {type: 'string', pattern: '^[a-f0-9]{64}$'};
const opId = {type: 'string', pattern: '^[a-zA-Z0-9_.:-]{1,128}$'};
const intent = {type: 'string', minLength: 1, maxLength: 160};
const paneId = {type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$'};
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});

// Bounded primitive configuration. Unknown fields are rejected, not ignored.
const config = object({
  font_size: {type: 'integer', minimum: TOOL_LIMITS.configFontMin, maximum: TOOL_LIMITS.configFontMax},
  show_counts: {type: 'boolean'},
}, []);

const data = object({text: {type: 'string', maxLength: TOOL_LIMITS.maxDataBytes}});

const writeKeys = {
  op_id: opId,
  intent,
};

export const toolRequests = Object.freeze({
  metadata_list: object({
    action: {const: 'metadata_list'},
    workspace_id: uuid,
    project_id: uuid,
  }, ['action', 'workspace_id']),

  resolve: object({
    action: {const: 'resolve'},
    workspace_id: uuid,
    pane_id: paneId,
    instance_id: uuid,
  }, ['action', 'workspace_id', 'pane_id']),

  data_read: object({
    action: {const: 'data_read'},
    workspace_id: uuid,
    project_id: uuid,
    instance_id: uuid,
    pane_id: paneId,
  }),

  data_save: object({
    action: {const: 'data_save'},
    workspace_id: uuid,
    project_id: uuid,
    instance_id: uuid,
    pane_id: paneId,
    expected_revision: {type: 'integer', minimum: 0},
    data,
    ...writeKeys,
  }),

  configure: object({
    action: {const: 'configure'},
    workspace_id: uuid,
    project_id: uuid,
    instance_id: uuid,
    expected_revision: {type: 'integer', minimum: 1},
    config,
    ...writeKeys,
  }),

  set_enabled: object({
    action: {const: 'set_enabled'},
    workspace_id: uuid,
    project_id: uuid,
    instance_id: uuid,
    expected_revision: {type: 'integer', minimum: 1},
    enabled: {type: 'boolean'},
    ...writeKeys,
  }),

  revoke: object({
    action: {const: 'revoke'},
    workspace_id: uuid,
    project_id: uuid,
    instance_id: uuid,
    expected_revision: {type: 'integer', minimum: 1},
    ...writeKeys,
  }),

  repin: object({
    action: {const: 'repin'},
    workspace_id: uuid,
    project_id: uuid,
    instance_id: uuid,
    expected_revision: {type: 'integer', minimum: 1},
    release_id: uuid,
    ...writeKeys,
  }),

  create_preview: object({
    action: {const: 'create_preview'},
    workspace_id: uuid,
    project_id: uuid,
    kind: {enum: [...TOOL_KINDS]},
    title: {type: 'string', minLength: 1, maxLength: TOOL_LIMITS.titleMax},
    release_id: uuid,
    config,
    base_revision: {type: 'integer', minimum: 1},
  }, ['action', 'workspace_id', 'project_id', 'kind', 'title', 'base_revision']),

  create_commit: object({
    action: {const: 'create_commit'},
    workspace_id: uuid,
    project_id: uuid,
    preview_id: uuid,
    preview_digest: hash,
    ...writeKeys,
  }),
});

export const toolSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Comet project tool requests v1',
  oneOf: Object.values(toolRequests),
};
