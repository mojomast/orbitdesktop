// Owner-facing arrangement/recipe request contracts (v1).
//
// These requests are served on the existing owner-authenticated
// `/api/workbench/workflow` route. They describe a *portable* arrangement intent:
// saved recipes snapshot only role constraints, layout and renderer names, never
// window/pane/binding UUIDs or private project content. Concrete binding choices
// stay per-preview (`role_choices`) and are validated against the live project
// bindings by the server compiler; a choice is never persisted in a recipe.
//
// `preview_id` / `preview_digest` are retained (not renamed to proposal_*) so the
// shipped frontend keeps working while the server gains durable proposal records.
export const ARRANGEMENT_ROLES = Object.freeze([
  'primary_agent',
  'active_terminal',
  'preview',
  'candidate_diff',
  'project_files',
]);
export const ARRANGEMENT_LAYOUTS = Object.freeze(['prioritize', 'columns', 'rows']);
export const ARRANGEMENT_RENDERERS = Object.freeze(['windows', 'spatial', 'docking']);
export const RECIPE_ENUM = Object.freeze(['project_focus', 'investigate', 'implement', 'review', 'return']);
export const ARRANGEMENT_LIMITS = Object.freeze({
  maxRecipes: 32,
  nameMax: 60,
  rolesMax: 5,
  roleChoicesMax: 5,
  ttlMs: 60000,
  proposalBytes: 2 * 1024 * 1024,
});

const uuid = {type: 'string', pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const hash = {type: 'string', pattern: '^[a-f0-9]{64}$'};
const scope = {workspace_id: uuid, project_id: uuid};
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const roles = {
  type: 'array',
  items: {enum: [...ARRANGEMENT_ROLES]},
  minItems: 0,
  maxItems: ARRANGEMENT_LIMITS.rolesMax,
  uniqueItems: true,
};
const roleChoices = {
  type: 'object',
  propertyNames: {enum: [...ARRANGEMENT_ROLES]},
  additionalProperties: uuid,
  maxProperties: ARRANGEMENT_LIMITS.roleChoicesMax,
};

export const arrangementRequests = Object.freeze({
  recipe_list: object({action: {const: 'recipe_list'}, ...scope}),
  recipe_save: object({
    action: {const: 'recipe_save'},
    ...scope,
    name: {type: 'string', minLength: 1, maxLength: ARRANGEMENT_LIMITS.nameMax},
    roles,
    layout: {enum: [...ARRANGEMENT_LAYOUTS]},
    renderer: {enum: [...ARRANGEMENT_RENDERERS]},
    recipe_id: uuid,
    expected_version: {type: 'integer', minimum: 1},
    // Optional durable operation key. When present, a retried save is reconciled
    // by op_id instead of creating a duplicate recipe; absent is legacy
    // (non-retry-safe) and reported as such.
    op_id: uuid,
    intent: {type: 'string', minLength: 1, maxLength: 160},
  }, ['action', 'workspace_id', 'project_id', 'name', 'roles', 'layout', 'renderer', 'op_id']),
  recipe_preview: object({
    action: {const: 'recipe_preview'},
    ...scope,
    recipe: {enum: [...RECIPE_ENUM]},
    recipe_id: uuid,
    role_choices: roleChoices,
    renderer: {enum: [...ARRANGEMENT_RENDERERS]},
    width: {type: 'number', minimum: 280, maximum: 16000},
    height: {type: 'number', minimum: 180, maximum: 16000},
  }, ['action', 'workspace_id', 'project_id', 'recipe']),
  recipe_apply: object({
    action: {const: 'recipe_apply'},
    ...scope,
    recipe: {enum: [...RECIPE_ENUM]},
    preview_id: uuid,
    preview_digest: hash,
    op_id: uuid,
    intent: {type: 'string', minLength: 1, maxLength: 160},
    // Optional re-measured viewport. When supplied it must equal the viewport
    // staged by the preview, otherwise the commit is refused as stale; it is
    // bound into the durable receipt identity either way.
    viewport: {type: 'object', properties: {width: {type: 'number', minimum: 280, maximum: 16000}, height: {type: 'number', minimum: 180, maximum: 16000}}, required: ['width', 'height'], additionalProperties: false},
  }, ['action', 'workspace_id', 'project_id', 'recipe', 'preview_id', 'preview_digest', 'op_id']),
  // Durable proposal inspection/rejection. These are read-mostly control
  // surfaces for the Normal controller and read-only Hermes tools; rejecting a
  // preview never edits workspace state.
  proposal_list: object({
    action: {const: 'proposal_list'},
    ...scope,
    recipe: {enum: [...RECIPE_ENUM]},
    after_id: uuid,
  }, ['action', 'workspace_id', 'project_id']),
  proposal_get: object({
    action: {const: 'proposal_get'},
    ...scope,
    proposal_id: uuid,
  }),
  proposal_reject: object({
    action: {const: 'proposal_reject'},
    ...scope,
    proposal_id: uuid,
    expected_version: {type: 'integer', minimum: 1},
  }),
});

export const arrangementSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Comet workspace arrangement requests v1',
  oneOf: Object.values(arrangementRequests),
};
