// Project tools: finite, trusted, host-rendered project surfaces.
//
// `createProjectTools({store,records,data,now})` owns the `tool_*` owner requests
// served on `/api/workbench/tools`. Two closed kinds are supported:
//
//   - `notebook`        private plain-text notes, independently revisioned (CAS)
//   - `evidence_checks` a read-only, sanitized projection of existing recorded
//                       Workbench evidence/review facts, never a new verdict
//
// Durability and identity model (mirrors `server/workspace-arrangements.mjs`):
//  - `create_preview` compiles an exact staged workspace state (one added
//    browser window whose URL is `orbit://project-tool/<instance-id>`) and
//    persists it as an immutable proposal with an exact digest and a 60s TTL.
//  - `create_commit` revalidates the base revision, project generation, recovery
//    generation, live release digest and proposal state inside the store's
//    synchronous `authorize` callback, i.e. under the same SQLite write
//    transaction and before the receipt lookup. Instance, authoritative surface
//    binding, checkpoint and both receipts commit or roll back together.
//  - Writes (`data_save`, `configure`, `set_enabled`, `revoke`, `repin`) require
//    `op_id` + `intent` and are reconciled from a durable, actor-scoped tool
//    receipt. A receipt replay returns the original metadata-only result even
//    after the workspace revision or proposal lifetime has moved on.
//  - A receipt for `data_save` stores metadata only; note bytes never enter a
//    receipt.
//  - Each instance also gets one independent authoritative host grant
//    (`wb_tool_grants`) minted in the same commit transaction, bound to the exact
//    project generation and the closed scope set for its kind. The instance
//    `enabled`/`revoked` fields remain a projection for the frozen UI. Every
//    privileged resolve/read/write/enable gate requires the current unrevoked
//    grant, so a manual grant revoke blocks access even when the projection still
//    looks enabled, and a project revoke + re-register is fenced by the project
//    generation rather than by rewriting WorkbenchStore.revoke.
//
// IDs are selectors, not authorization. The pane URL, `instance_id` and
// `pane_id` are revalidated against the authoritative `wb_tool_bindings` row and
// the actual current pane. No generated frame, Normal controller, Hermes tool or
// workspace description ever reads notes.

import {createHash, randomUUID} from 'node:crypto';
import Ajv from 'ajv';
import {validate} from '../src/model.ts';
import {applyOperation} from '../src/workspace-ops.ts';
import {wbError} from './workbench-store.mjs';
import {WorkbenchData} from './workbench-data.mjs';
import {canonicalJson} from './command-identity.mjs';
import {TOOL_KINDS, TOOL_LIMITS, toolRequests, toolSchema} from '../contracts/project-tools-v1.mjs';
import {projectToolChecks} from './project-tools-evidence.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(canonicalJson(value));
const valid = new Ajv({strict: true}).compile(toolSchema);

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const toolUrl = id => `orbit://project-tool/${id}`;
const toolUrlPattern = /^orbit:\/\/project-tool\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;

const DEFAULT_RELEASE = '1';
const DEFINITION_TITLES = Object.freeze({notebook: 'Notebook', evidence_checks: 'Recorded evidence'});

// Closed trusted host descriptors. The digest binds the exact finite host
// rendering contract (component, kind, render/data versions and exposed
// features). It is deliberately NOT a claim about arbitrary executable bytes or
// a tested third-party publication; that is later milestone work.
const HOST_DESCRIPTORS = Object.freeze({
  notebook: Object.freeze({
    '1': Object.freeze({component: 'orbit-project-tools-host', kind: 'notebook', render_version: 1, data_schema_version: 1, features: Object.freeze({count: false, config: Object.freeze(['font_size', 'show_counts'])})}),
    '2': Object.freeze({component: 'orbit-project-tools-host', kind: 'notebook', render_version: 2, data_schema_version: 1, features: Object.freeze({count: true, config: Object.freeze(['font_size', 'show_counts'])})}),
  }),
  evidence_checks: Object.freeze({
    '1': Object.freeze({component: 'orbit-project-tools-host', kind: 'evidence_checks', render_version: 1, data_schema_version: 1, display: 'records', features: Object.freeze({counts: false})}),
    '2': Object.freeze({component: 'orbit-project-tools-host', kind: 'evidence_checks', render_version: 2, data_schema_version: 1, display: 'compact', features: Object.freeze({counts: true})}),
  }),
});
const hostDigest = (kind, release) => digest(HOST_DESCRIPTORS[kind][release]);

const heldError = () => Object.assign(wbError('conflict'), {reason: 'recovery_hold'});
// Same generation-fenced semantics as the workspace store's durable receipts.
const policyChangedError = () => Object.assign(wbError('stale_resource'), {reason: 'RECOVERY_POLICY_CHANGED', category: 'RECOVERY_POLICY_CHANGED'});
const asToolError = error => {
  if (error?.code) return error;
  if (error?.category === 'REVISION_CONFLICT' || error?.category === 'RECOVERY_POLICY_CHANGED') return Object.assign(wbError('stale_resource'), {reason: error.category});
  if (error?.category === 'IDEMPOTENCY_CONFLICT') return Object.assign(wbError('conflict'), {reason: error.category});
  if (error?.category === 'RECOVERY_HOLD') return heldError();
  if (error?.category === 'RESOURCE_BUSY') return Object.assign(wbError('busy'), {reason: error.category});
  if (typeof error?.code === 'string' && error.code.startsWith('SQLITE_')) return Object.assign(wbError('conflict'), {reason: 'store_constraint'});
  return error;
};

function publicDefinition(record) {
  return {version: 1, id: record.id, workspace_id: record.workspace_id, kind: record.kind, title: record.title, created_at: record.created_at, updated_at: record.updated_at};
}
function publicRelease(record) {
  return {version: 1, id: record.id, definition_id: record.definition_id, release: record.release, host_digest: record.host_digest, data_schema_version: record.data_schema_version, status: record.status, render_version: record.render_version, created_at: record.created_at};
}
function publicInstance(record) {
  return {version: 1, id: record.id, workspace_id: record.workspace_id, project_id: record.project_id, definition_id: record.definition_id, release_id: record.release_id, kind: record.kind, title: record.title, config: structuredClone(record.config ?? {}), enabled: record.enabled === true, revoked: record.revoked === true, grant_id: record.grant_id ?? null, revision: record.revision, created_at: record.created_at, updated_at: record.updated_at};
}
function publicGrant(record) {
  return {version: 1, id: record.id, workspace_id: record.workspace_id, project_id: record.project_id, instance_id: record.instance_id, revision: record.revision, project_generation: record.project_generation, scopes: [...(record.scopes ?? [])], revoked: record.revoked === true, created_at: record.created_at, updated_at: record.updated_at};
}

// Closed, finite host scopes. A grant is an independent authoritative record;
// `instance.enabled`/`revoked` remain a frozen UI projection only.
const GRANT_SCOPES = Object.freeze({
  notebook: Object.freeze(['notebook.read', 'notebook.write']),
  evidence_checks: Object.freeze(['evidence.read']),
});

function paneIn(state, paneId) {
  for (const monitor of state.monitors) {
    let found = null;
    const visit = node => {
      if (node.type === 'pane') { if (node.pane.id === paneId) found = node.pane; }
      else { visit(node.first); visit(node.second); }
    };
    visit(monitor.layout);
    if (found) return found;
  }
  return null;
}
function findPaneByUrl(state, url) {
  for (const monitor of state.monitors) {
    let found = null;
    const visit = node => {
      if (node.type === 'pane') { if (node.pane.url === url) found = node.pane; }
      else { visit(node.first); visit(node.second); }
    };
    visit(monitor.layout);
    if (found) return found;
  }
  return null;
}

function previewDiff(kind, title, release) {
  const label = kind === 'notebook' ? 'private notebook' : 'recorded-evidence checks card';
  const summary = value => { const text = String(value); return text.length <= 300 ? text : `${[...text].slice(0, 299).join('')}…`; };
  return [
    {kind: 'add', summary: summary(`Add window “${title}” hosting a trusted ${label}`)},
    {kind: 'tool', summary: summary(`Host renderer release ${release.release} · data schema v${release.data_schema_version} · ${kind === 'notebook' ? 'notes stay host-owned' : 'read-only recorded facts'}`)},
    {kind: 'authority', summary: summary('No generated frame, credential or model project access; IDs are selectors, not authorization.')},
  ];
}

export function createProjectTools({store, records, data, now = Date.now} = {}) {
  if (typeof store?.read !== 'function' || typeof store?.commit !== 'function' || typeof records?.project !== 'function') throw Error('Project tool dependencies required');
  data = data ?? new WorkbenchData(store);

  // --- low-level reads -----------------------------------------------------
  const rawProject = (workspaceId, projectId) => {
    const row = data.db.prepare('SELECT record_json FROM wb_projects WHERE id=? AND workspace_id=?').get(projectId, workspaceId);
    if (!row) throw wbError('permission_denied');
    return JSON.parse(row.record_json);
  };
  const getInstance = (workspaceId, projectId, id) => {
    if (!uuidPattern.test(id || '')) throw wbError('invalid_request');
    const row = data.db.prepare('SELECT record_json FROM wb_tool_instances WHERE id=? AND workspace_id=? AND project_id=?').get(id, workspaceId, projectId);
    if (!row) throw wbError('permission_denied');
    return JSON.parse(row.record_json);
  };
  const getRelease = id => {
    if (!uuidPattern.test(id || '')) return null;
    const row = data.db.prepare('SELECT record_json FROM wb_tool_releases WHERE id=?').get(id);
    return row ? JSON.parse(row.record_json) : null;
  };
  const getDefinition = id => {
    if (!uuidPattern.test(id || '')) return null;
    const row = data.db.prepare('SELECT record_json FROM wb_tool_definitions WHERE id=?').get(id);
    return row ? JSON.parse(row.record_json) : null;
  };
  // Closed host compatibility. A release is usable only when it resolves to the
  // exact trusted descriptor for its definition kind, render_version, data
  // schema and digest — not merely because a database row exists with an
  // unchanged/self-consistent digest. `render_version` must be known (1/2) and
  // the data schema must be exactly 1.
  function requireSupportedReleaseFor(kind, definitionId, release) {
    const definition = getDefinition(definitionId);
    if (!definition || definition.kind !== kind) throw wbError('unsupported');
    if (!release || release.status !== 'available' || release.definition_id !== definitionId) throw wbError('unsupported');
    const descriptor = HOST_DESCRIPTORS[kind]?.[String(release.release)];
    if (!descriptor) throw wbError('unsupported');
    if (release.render_version !== descriptor.render_version) throw wbError('unsupported');
    if (release.data_schema_version !== 1 || descriptor.data_schema_version !== 1) throw wbError('unsupported');
    if (release.host_digest !== hostDigest(kind, release.release)) throw wbError('unsupported');
    return {definition, descriptor};
  }
  const requireSupportedRelease = (instance, release) => requireSupportedReleaseFor(instance.kind, instance.definition_id, release);
  // Persisted private data schema. Absent data is schema 1 (nothing to
  // downgrade); any present row other than exactly 1 is future/incompatible and
  // must be refused without rewriting it.
  function storedData(instanceId) {
    const row = data.db.prepare('SELECT revision,record_json FROM wb_tool_data WHERE instance_id=?').get(instanceId);
    if (!row) return {revision: 0, schema: 1, value: null};
    const value = JSON.parse(row.record_json);
    return {revision: row.revision, schema: Number.isInteger(value.data_schema_version) ? value.data_schema_version : null, value};
  }
  function requireCurrentDataSchema(instanceId) {
    const stored = storedData(instanceId);
    if (stored.schema !== 1) throw Object.assign(wbError('unsupported'), {reason: 'incompatible_data_schema'});
    return stored;
  }
  const getProposal = (workspaceId, projectId, id) => {
    const row = data.db.prepare('SELECT record_json FROM wb_tool_proposals WHERE id=? AND workspace_id=? AND project_id=?').get(id, workspaceId, projectId);
    return row ? JSON.parse(row.record_json) : null;
  };
  const bindingFor = (workspaceId, paneId) => data.db.prepare('SELECT * FROM wb_tool_bindings WHERE workspace_id=? AND pane_id=?').get(workspaceId, paneId) ?? null;
  const policyOf = workspace => workspace.recovery_policy ?? {held: false, generation: 0};

  const updateInstance = (instance, patch) => {
    const next = {...instance, ...patch, revision: instance.revision + 1, updated_at: now()};
    const changed = data.db.prepare('UPDATE wb_tool_instances SET revision=?,record_json=? WHERE id=? AND revision=?').run(next.revision, JSON.stringify(next), instance.id, instance.revision);
    if (changed.changes !== 1) throw wbError('stale_resource');
    return next;
  };

  // --- closed host grants --------------------------------------------------
  const getGrant = instanceId => {
    const row = data.db.prepare('SELECT record_json FROM wb_tool_grants WHERE instance_id=?').get(instanceId);
    return row ? JSON.parse(row.record_json) : null;
  };
  const updateGrant = (grant, patch) => {
    const next = {...grant, ...patch, revision: grant.revision + 1, updated_at: now()};
    const changed = data.db.prepare('UPDATE wb_tool_grants SET revision=?,record_json=? WHERE id=? AND revision=?').run(next.revision, JSON.stringify(next), grant.id, grant.revision);
    if (changed.changes !== 1) throw wbError('stale_resource');
    return next;
  };
  const sameScopes = (candidate, expected) => Array.isArray(candidate) && candidate.length === expected.length && expected.every(scope => candidate.includes(scope));
  // A grant is valid only while it is the current, unrevoked record for this
  // instance, belongs to this workspace/project instance, was minted for the
  // current project generation (so a revoke + re-register cannot resurrect it)
  // and carries exactly the closed scope set for its kind.
  function requireGrantKind(workspace, instance, project) {
    const grant = getGrant(instance.id);
    if (!grant || grant.revoked === true) throw wbError('revoked');
    if (grant.workspace_id !== workspace.id || grant.project_id !== instance.project_id || grant.instance_id !== instance.id) throw wbError('permission_denied');
    if (grant.project_generation !== project.generation) throw Object.assign(wbError('stale_resource'), {reason: 'project_generation'});
    if (!sameScopes(grant.scopes, GRANT_SCOPES[instance.kind] ?? [])) throw Object.assign(wbError('permission_denied'), {reason: 'grant_scope'});
    return grant;
  }
  function requireGrantScope(workspace, instance, project, scope) {
    const grant = requireGrantKind(workspace, instance, project);
    if (!grant.scopes.includes(scope)) throw Object.assign(wbError('permission_denied'), {reason: 'grant_scope'});
    return grant;
  }
  const readScope = kind => (kind === 'notebook' ? 'notebook.read' : 'evidence.read');

  function assertBoundPane(workspace, instance, paneId) {
    const binding = data.db.prepare('SELECT * FROM wb_tool_bindings WHERE workspace_id=? AND project_id=? AND instance_id=? AND pane_id=?').get(workspace.id, instance.project_id, instance.id, paneId);
    if (!binding) throw wbError('permission_denied');
    const pane = paneIn(workspace.state, paneId);
    if (!pane || pane.kind !== 'browser' || pane.url !== toolUrl(instance.id)) throw wbError('permission_denied');
    return binding;
  }

  // --- seeding -------------------------------------------------------------
  // Definitions and their two closed host releases are workspace-scoped and
  // seeded idempotently inside one immediate transaction. Never seeded while a
  // recovery hold is active; never updated once seeded.
  function ensureDefinitions(workspace) {
    if (policyOf(workspace).held) return;
    data.db.transaction(() => {
      const existing = data.db.prepare('SELECT record_json FROM wb_tool_definitions WHERE workspace_id=?').all(workspace.id).map(row => JSON.parse(row.record_json));
      const time = now();
      for (const kind of TOOL_KINDS) {
        let definition = existing.find(record => record.kind === kind);
        if (!definition) {
          definition = {version: 1, id: randomUUID(), workspace_id: workspace.id, kind, title: DEFINITION_TITLES[kind], created_at: time, updated_at: time};
          data.db.prepare('INSERT INTO wb_tool_definitions(id,workspace_id,record_json) VALUES (?,?,?)').run(definition.id, workspace.id, JSON.stringify(definition));
        }
        const releases = data.db.prepare('SELECT record_json FROM wb_tool_releases WHERE definition_id=?').all(definition.id).map(row => JSON.parse(row.record_json));
        for (const release of ['1', '2']) {
          if (releases.some(record => record.release === release)) continue;
          const value = {version: 1, id: randomUUID(), definition_id: definition.id, release, host_digest: hostDigest(kind, release), data_schema_version: 1, status: 'available', render_version: Number(release), created_at: time};
          data.db.prepare('INSERT INTO wb_tool_releases(id,definition_id,record_json) VALUES (?,?,?)').run(value.id, definition.id, JSON.stringify(value));
        }
      }
    }).immediate();
  }

  function selectDefinitionRelease(workspaceId, kind, releaseId) {
    const definition = data.db.prepare('SELECT record_json FROM wb_tool_definitions WHERE workspace_id=?').all(workspaceId).map(row => JSON.parse(row.record_json)).find(record => record.kind === kind);
    if (!definition) throw wbError('unavailable');
    const releases = data.db.prepare('SELECT record_json FROM wb_tool_releases WHERE definition_id=?').all(definition.id).map(row => JSON.parse(row.record_json)).filter(record => record.status === 'available');
    const release = releaseId ? releases.find(record => record.id === releaseId) : releases.find(record => record.release === DEFAULT_RELEASE);
    if (!release) throw wbError('unsupported');
    // Validate the exact trusted descriptor, not merely status/definition.
    requireSupportedReleaseFor(kind, definition.id, release);
    return {definition, release};
  }

  function normalizeConfig(config) {
    if (config === undefined || config === null) return {};
    if (typeof config !== 'object' || Array.isArray(config)) throw wbError('invalid_request');
    const out = {};
    if (config.font_size !== undefined) out.font_size = config.font_size;
    if (config.show_counts !== undefined) out.show_counts = config.show_counts;
    if (Buffer.byteLength(JSON.stringify(out)) > TOOL_LIMITS.maxConfigBytes) throw wbError('limit_exceeded');
    return out;
  }

  // --- receipts ------------------------------------------------------------
  function writeReceipt({workspaceId, actor, opId, requestHash, intent, kind, result, policyGeneration}) {
    const count = data.db.prepare('SELECT count(*) AS n FROM wb_tool_receipts WHERE workspace_id=?').get(workspaceId).n;
    if (count >= TOOL_LIMITS.maxReceipts) throw wbError('limit_exceeded');
    data.db.prepare('INSERT INTO wb_tool_receipts(workspace_id,actor,op_id,request_hash,intent,kind,result_json,policy_generation,created) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(workspaceId, actor, opId, requestHash, intent, kind, JSON.stringify(result), policyGeneration, now());
  }
  function receipt(workspaceId, actor, opId) {
    return data.db.prepare('SELECT request_hash,result_json,policy_generation FROM wb_tool_receipts WHERE workspace_id=? AND actor=? AND op_id=?').get(workspaceId, actor, opId) ?? null;
  }
  // A receipt is only replayable within the recovery policy generation it was
  // written under. A same-generation replay is still answered after ordinary
  // CAS/TTL changes (and after a project revoke, since the stored result is
  // metadata only and returns no private data); a hold/release transition makes
  // every older receipt obsolete. This mirrors the workspace store's
  // RECOVERY_POLICY_CHANGED fence. There is no automatic new-operation retry.
  function assertReceiptGeneration(prior, workspaceId) {
    const current = policyOf(store.read(workspaceId)).generation ?? 0;
    if ((prior.policy_generation ?? 0) !== current) throw policyChangedError();
  }
  const writeIdentity = body => {
    const base = {action: body.action, workspace_id: body.workspace_id, project_id: body.project_id, instance_id: body.instance_id, expected_revision: body.expected_revision, op_id: body.op_id, intent: body.intent};
    if (body.action === 'data_save') return {...base, pane_id: body.pane_id, data: {text: body.data.text}};
    if (body.action === 'configure') return {...base, config: body.config};
    if (body.action === 'set_enabled') return {...base, enabled: body.enabled};
    if (body.action === 'repin') return {...base, release_id: body.release_id};
    return base;
  };

  function runWrite(body, actor, kind, work) {
    const requestHash = digest(writeIdentity(body));
    return data.db.transaction(() => {
      // Receipt first: an exact replay is answered even after the workspace
      // revision moved or a proposal expired. A changed payload on the same key
      // is a conflict, never a reapply.
      //
      // NOTE: replay is deliberately answered before re-authorizing the current
      // grant/project/revision state. That is safe because every stored result is
      // metadata only: `data_save` receipts hold {revision,instance_id,
      // data_schema_version} and no note bytes, and no action's receipt exposes
      // private content. A caller that requires current authorization must issue
      // a new operation (a new op_id).
      const prior = receipt(body.workspace_id, actor, body.op_id);
      if (prior) {
        if (prior.request_hash !== requestHash) throw Object.assign(wbError('conflict'), {reason: 'operation_key_reuse'});
        assertReceiptGeneration(prior, body.workspace_id);
        return JSON.parse(prior.result_json);
      }
      const result = work();
      const generation = policyOf(store.read(body.workspace_id)).generation ?? 0;
      writeReceipt({workspaceId: body.workspace_id, actor, opId: body.op_id, requestHash, intent: body.intent, kind, result, policyGeneration: generation});
      return result;
    }).immediate();
  }

  // --- reads ---------------------------------------------------------------
  const legacyPlugins = state => (state.plugins ?? []).slice(0, 32).map(plugin => ({id: plugin.manifest?.id ?? null, version: plugin.manifest?.version ?? null, title: plugin.manifest?.title ?? null, enabled: plugin.enabled === true, window_id: plugin.window?.id ?? null, window_name: plugin.window?.name ?? null}));

  function metadataList(body) {
    const workspace = store.read(body.workspace_id);
    if (!policyOf(workspace).held) ensureDefinitions(workspace);
    if (body.project_id) rawProject(body.workspace_id, body.project_id);
    const definitions = data.db.prepare('SELECT record_json FROM wb_tool_definitions WHERE workspace_id=?').all(body.workspace_id).map(row => JSON.parse(row.record_json));
    const ids = new Set(definitions.map(record => record.id));
    const releases = data.db.prepare('SELECT record_json FROM wb_tool_releases').all().map(row => JSON.parse(row.record_json)).filter(record => ids.has(record.definition_id));
    const instances = body.project_id
      ? data.db.prepare('SELECT record_json FROM wb_tool_instances WHERE workspace_id=? AND project_id=?').all(body.workspace_id, body.project_id).map(row => JSON.parse(row.record_json))
      : data.db.prepare('SELECT record_json FROM wb_tool_instances WHERE workspace_id=?').all(body.workspace_id).map(row => JSON.parse(row.record_json));
    // Grants are host-only records. Their sanitized projection carries identity,
    // generation, scope set and revoke state only; never notebook/check bytes.
    const grants = body.project_id
      ? data.db.prepare('SELECT record_json FROM wb_tool_grants WHERE workspace_id=? AND project_id=?').all(body.workspace_id, body.project_id).map(row => JSON.parse(row.record_json))
      : data.db.prepare('SELECT record_json FROM wb_tool_grants WHERE workspace_id=?').all(body.workspace_id).map(row => JSON.parse(row.record_json));
    const byCreated = (a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || String(a.id).localeCompare(String(b.id));
    return {
      definitions: definitions.map(publicDefinition).sort(byCreated),
      releases: releases.map(publicRelease).sort(byCreated),
      instances: instances.map(publicInstance).sort(byCreated),
      grants: grants.map(publicGrant).sort(byCreated),
      legacy_plugins: legacyPlugins(workspace.state),
      limits: TOOL_LIMITS,
    };
  }

  function resolve(body) {
    const workspace = store.read(body.workspace_id);
    const pane = paneIn(workspace.state, body.pane_id);
    if (!pane || pane.kind !== 'browser') throw wbError('permission_denied');
    const match = toolUrlPattern.exec(pane.url ?? '');
    if (!match) throw wbError('permission_denied');
    const urlInstance = match[1];
    if (body.instance_id && body.instance_id !== urlInstance) throw Object.assign(wbError('stale_resource'), {reason: 'instance_selector_mismatch'});
    const binding = bindingFor(body.workspace_id, body.pane_id);
    if (!binding || binding.instance_id !== urlInstance) throw wbError('permission_denied');
    const instance = getInstance(binding.workspace_id, binding.project_id, urlInstance);
    const project = rawProject(binding.workspace_id, binding.project_id);
    if (project.active === false) throw wbError('permission_denied');
    // Hold dominates: it is reported even for an instance the hold transaction
    // disabled, so the refusal reason is the policy, not the instance state.
    if (policyOf(workspace).held) throw heldError();
    // Independent authoritative grant: a revoked or wrong-generation grant
    // blocks the surface even when the instance projection still looks enabled.
    requireGrantScope(workspace, instance, project, readScope(instance.kind));
    if (instance.revoked) throw wbError('revoked');
    if (!instance.enabled) throw wbError('unavailable');
    const release = getRelease(instance.release_id);
    requireSupportedRelease(instance, release);
    const result = {instance: publicInstance(instance), release: publicRelease(release), policy_generation: policyOf(workspace).generation ?? 0};
    if (instance.kind === 'evidence_checks') result.checks = projectToolChecks({data}, {workspace_id: binding.workspace_id, project_id: binding.project_id});
    return result;
  }

  function dataRead(body) {
    const workspace = store.read(body.workspace_id);
    if (policyOf(workspace).held) throw heldError();
    const project = rawProject(body.workspace_id, body.project_id);
    if (project.active === false) throw wbError('permission_denied');
    const instance = getInstance(body.workspace_id, body.project_id, body.instance_id);
    requireGrantScope(workspace, instance, project, readScope(instance.kind));
    if (instance.revoked) throw wbError('revoked');
    if (!instance.enabled) throw wbError('unavailable');
    assertBoundPane(workspace, instance, body.pane_id);
    requireSupportedRelease(instance, getRelease(instance.release_id));
    const stored = requireCurrentDataSchema(instance.id);
    // The revision column, not the record body, is authoritative; the persisted
    // data schema is reported exactly as stored (absent data is schema 1).
    return {data: {text: stored.value?.text ?? ''}, revision: stored.revision, data_schema_version: stored.schema, instance_revision: instance.revision, policy_generation: policyOf(workspace).generation ?? 0};
  }

  // --- writes --------------------------------------------------------------
  function dataSave(body, actor) {
    return runWrite(body, actor, 'data_save', () => {
      const workspace = store.read(body.workspace_id);
      if (policyOf(workspace).held) throw heldError();
      const project = rawProject(body.workspace_id, body.project_id);
      if (project.active === false) throw wbError('permission_denied');
      const instance = getInstance(body.workspace_id, body.project_id, body.instance_id);
      requireGrantScope(workspace, instance, project, 'notebook.write');
      if (instance.revoked) throw wbError('revoked');
      if (!instance.enabled) throw wbError('unavailable');
      assertBoundPane(workspace, instance, body.pane_id);
      requireSupportedRelease(instance, getRelease(instance.release_id));
      // A future/incompatible stored schema is refused before any write; this
      // path can never downgrade it to 1.
      const stored = requireCurrentDataSchema(instance.id);
      const text = body.data.text;
      if (Buffer.byteLength(text, 'utf8') > TOOL_LIMITS.maxDataBytes) throw wbError('limit_exceeded');
      if (body.expected_revision !== stored.revision) throw wbError('stale_resource');
      const revision = stored.revision + 1;
      const value = {version: 1, instance_id: instance.id, data_schema_version: 1, text, updated_at: now()};
      data.db.prepare('INSERT INTO wb_tool_data(instance_id,workspace_id,project_id,revision,record_json) VALUES (?,?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json')
        .run(instance.id, body.workspace_id, body.project_id, revision, JSON.stringify(value));
      // Metadata only: note text never enters the durable receipt.
      return {revision, instance_id: instance.id, data_schema_version: 1};
    });
  }

  function configure(body, actor) {
    return runWrite(body, actor, 'configure', () => {
      const workspace = store.read(body.workspace_id);
      if (policyOf(workspace).held) throw heldError();
      const project = rawProject(body.workspace_id, body.project_id);
      if (project.active === false) throw wbError('permission_denied');
      const instance = getInstance(body.workspace_id, body.project_id, body.instance_id);
      requireGrantKind(workspace, instance, project);
      if (instance.revoked) throw wbError('revoked');
      if (instance.revision !== body.expected_revision) throw wbError('stale_resource');
      const next = updateInstance(instance, {config: normalizeConfig(body.config)});
      return {instance: publicInstance(next)};
    });
  }

  function setEnabled(body, actor) {
    return runWrite(body, actor, 'set_enabled', () => {
      const workspace = store.read(body.workspace_id);
      const project = rawProject(body.workspace_id, body.project_id);
      const instance = getInstance(body.workspace_id, body.project_id, body.instance_id);
      if (instance.revoked) throw wbError('revoked');
      if (body.enabled) {
        // Report the policy/project/grant gate ahead of the CAS so a held,
        // revoked or generation-fenced instance is never mistaken for an
        // ordinary stale revision.
        if (policyOf(workspace).held) throw heldError();
        if (project.active === false) throw wbError('permission_denied');
        requireGrantKind(workspace, instance, project);
        // Enabling requires the exact current trusted host descriptor.
        requireSupportedRelease(instance, getRelease(instance.release_id));
      }
      if (instance.revision !== body.expected_revision) throw wbError('stale_resource');
      const next = updateInstance(instance, {enabled: body.enabled});
      return {instance: publicInstance(next)};
    });
  }

  function revoke(body, actor) {
    return runWrite(body, actor, 'revoke', () => {
      const workspace = store.read(body.workspace_id);
      rawProject(body.workspace_id, body.project_id);
      const instance = getInstance(body.workspace_id, body.project_id, body.instance_id);
      if (instance.revoked) throw wbError('stale_resource');
      if (instance.revision !== body.expected_revision) throw wbError('stale_resource');
      // Terminal and one-way. The independent authoritative grant is revoked in
      // the same transaction; private data and the binding row are retained, not
      // deleted, and a layout restore cannot revive a revoked instance.
      const grant = getGrant(instance.id);
      if (grant && grant.revoked !== true) updateGrant(grant, {revoked: true});
      const next = updateInstance(instance, {revoked: true, enabled: false});
      return {instance: publicInstance(next)};
    });
  }

  function repin(body, actor) {
    return runWrite(body, actor, 'repin', () => {
      const workspace = store.read(body.workspace_id);
      if (policyOf(workspace).held) throw heldError();
      const project = rawProject(body.workspace_id, body.project_id);
      if (project.active === false) throw wbError('permission_denied');
      const instance = getInstance(body.workspace_id, body.project_id, body.instance_id);
      requireGrantKind(workspace, instance, project);
      if (instance.revoked) throw wbError('revoked');
      if (instance.revision !== body.expected_revision) throw wbError('stale_resource');
      // Both the current pin and the target must be exact trusted descriptors,
      // and the stored data must still be schema 1: repin refuses on incompatible
      // DATA, not merely on a difference between two release fields.
      requireSupportedRelease(instance, getRelease(instance.release_id));
      requireSupportedReleaseFor(instance.kind, instance.definition_id, getRelease(body.release_id));
      const stored = storedData(instance.id);
      if (stored.schema !== 1) throw Object.assign(wbError('unsupported'), {reason: 'incompatible_data_schema'});
      // Repin never touches wb_tool_data: notes are preserved across a
      // compatible update and a later revert.
      const target = getRelease(body.release_id);
      const next = updateInstance(instance, {release_id: target.id});
      return {instance: publicInstance(next)};
    });
  }

  // --- preview / commit ----------------------------------------------------
  function createPreview(body, actor) {
    const workspace = store.read(body.workspace_id);
    if (policyOf(workspace).held) throw heldError();
    const project = records.project(body.workspace_id, body.project_id);
    if (body.base_revision !== workspace.revision) throw Object.assign(wbError('stale_resource'), {reason: 'base_revision'});
    ensureDefinitions(workspace);
    const {definition, release} = selectDefinitionRelease(body.workspace_id, body.kind, body.release_id);
    const config = normalizeConfig(body.config);
    const title = body.title.trim();
    if (!title) throw wbError('invalid_request');
    const instanceId = randomUUID();
    const operation = {action: 'add_window', kind: 'browser', name: title, url: toolUrl(instanceId)};
    const staged = validate(applyOperation(structuredClone(workspace.state), operation));
    const pane = findPaneByUrl(staged, toolUrl(instanceId));
    if (!pane) throw wbError('unsupported');
    const identity = {
      version: 1,
      workspace_id: body.workspace_id,
      project_id: body.project_id,
      kind: body.kind,
      title,
      definition_id: definition.id,
      release_id: release.id,
      host_digest: release.host_digest,
      data_schema_version: release.data_schema_version,
      base_revision: workspace.revision,
      project_generation: project.generation,
      recovery_generation: policyOf(workspace).generation ?? 0,
      instance_id: instanceId,
      config,
      operations: [operation],
      staged_state: staged,
    };
    const previewDigest = digest(identity);
    return data.db.transaction(() => {
      data.db.prepare("DELETE FROM wb_tool_proposals WHERE workspace_id=? AND json_extract(record_json,'$.status')='previewed' AND json_extract(record_json,'$.op_id') IS NULL AND json_extract(record_json,'$.expires_at')<=?").run(body.workspace_id, now());
      const count = data.db.prepare('SELECT count(*) AS n FROM wb_tool_proposals WHERE workspace_id=?').get(body.workspace_id).n;
      if (count >= TOOL_LIMITS.maxProposals) throw wbError('limit_exceeded');
      const id = randomUUID();
      const created = now();
      const expires_at = created + TOOL_LIMITS.previewTtlMs;
      const record = {
        version: 1,
        id,
        workspace_id: body.workspace_id,
        project_id: body.project_id,
        kind: body.kind,
        title,
        definition_id: definition.id,
        release_id: release.id,
        host_digest: release.host_digest,
        data_schema_version: release.data_schema_version,
        config,
        base_revision: workspace.revision,
        project_generation: project.generation,
        recovery_generation: policyOf(workspace).generation ?? 0,
        instance_id: instanceId,
        pane_id: pane.id,
        operations: [operation],
        staged_state: staged,
        preview_digest: previewDigest,
        status: 'previewed',
        op_id: null,
        committed_actor: null,
        committed_revision: null,
        checkpoint_id: null,
        actor,
        created_at: created,
        expires_at,
        updated_at: created,
      };
      data.db.prepare('INSERT INTO wb_tool_proposals(id,workspace_id,project_id,record_json) VALUES (?,?,?,?)').run(id, body.workspace_id, body.project_id, JSON.stringify(record));
      return {preview_id: id, preview_digest: previewDigest, expires_at, diff: previewDiff(body.kind, title, release), rendered: false, tested: false};
    }).immediate();
  }

  function markProposalStale(proposal) {
    try {
      data.db.transaction(() => {
        const row = data.db.prepare('SELECT record_json FROM wb_tool_proposals WHERE id=?').get(proposal.id);
        if (!row) return;
        const current = JSON.parse(row.record_json);
        if (current.status !== 'previewed') return;
        data.db.prepare('UPDATE wb_tool_proposals SET record_json=? WHERE id=?').run(JSON.stringify({...current, status: 'stale', updated_at: now()}), proposal.id);
      }).immediate();
    } catch {}
  }

  function createCommit(body, actor) {
    const requestHash = digest({action: 'create_commit', workspace_id: body.workspace_id, project_id: body.project_id, preview_id: body.preview_id, preview_digest: body.preview_digest, op_id: body.op_id, intent: body.intent});
    // Receipt first: an exact committed retry is answered even after the
    // workspace revision or proposal lifetime moved on.
    const prior = receipt(body.workspace_id, actor, body.op_id);
    if (prior) {
      if (prior.request_hash !== requestHash) throw Object.assign(wbError('conflict'), {reason: 'operation_key_reuse'});
      assertReceiptGeneration(prior, body.workspace_id);
      return JSON.parse(prior.result_json);
    }
    const proposal = getProposal(body.workspace_id, body.project_id, body.preview_id);
    if (!proposal) throw wbError('expired');
    if (proposal.status !== 'previewed') throw wbError('stale_resource');
    if (proposal.preview_digest !== body.preview_digest) throw Object.assign(wbError('stale_resource'), {reason: 'preview_digest'});
    if (now() > proposal.expires_at) { markProposalStale(proposal); throw wbError('expired'); }
    const workspace = store.read(body.workspace_id);
    if (policyOf(workspace).held) throw heldError();
    const release = getRelease(proposal.release_id);
    // Validate the exact trusted descriptor (known render/data version and exact
    // host digest), not merely an unchanged database digest.
    requireSupportedReleaseFor(proposal.kind, proposal.definition_id, release);
    if (release.host_digest !== proposal.host_digest) throw Object.assign(wbError('stale_resource'), {reason: 'release_changed'});

    const command = {
      workspaceId: body.workspace_id,
      actor,
      operationId: body.op_id,
      intent: body.intent,
      requestHash,
      action: 'create_commit',
      baseRevision: proposal.base_revision,
      legacy: false,
    };
    const authorize = previous => {
      if ((previous?.recovery_policy?.generation ?? 0) !== proposal.recovery_generation) throw Object.assign(wbError('stale_resource'), {reason: 'recovery_generation'});
      if (previous?.recovery_policy?.held) throw heldError();
      if (previous?.revision !== proposal.base_revision) throw Object.assign(wbError('stale_resource'), {reason: 'base_revision'});
      const live = getProposal(body.workspace_id, body.project_id, body.preview_id);
      if (!live || live.status !== 'previewed') throw Object.assign(wbError('stale_resource'), {reason: 'proposal_changed'});
      if (now() > live.expires_at) throw wbError('expired');
      const project = records.project(body.workspace_id, body.project_id);
      if (project.generation !== proposal.project_generation) throw Object.assign(wbError('stale_resource'), {reason: 'project_generation'});
      const current = getRelease(live.release_id);
      requireSupportedReleaseFor(live.kind, live.definition_id, current);
      if (current.host_digest !== live.host_digest) throw Object.assign(wbError('stale_resource'), {reason: 'release_changed'});
      return true;
    };

    let committed;
    try {
      committed = store.commit(command, {
        authorize,
        apply: () => structuredClone(proposal.staged_state),
        checkpointLabel: `Before ${proposal.kind} tool install`,
        // Runs inside the store's BEGIN IMMEDIATE transaction: instance, binding,
        // proposal disposition, checkpoint and both receipts commit or roll back
        // together.
        response: (record, checkpoint) => {
          const time = now();
          const grantId = randomUUID();
          const instance = {version: 1, id: proposal.instance_id, workspace_id: body.workspace_id, project_id: body.project_id, definition_id: proposal.definition_id, release_id: proposal.release_id, kind: proposal.kind, title: proposal.title, config: proposal.config, enabled: true, revoked: false, grant_id: grantId, revision: 1, created_at: time, updated_at: time};
          data.db.prepare('INSERT INTO wb_tool_instances(id,workspace_id,project_id,revision,record_json) VALUES (?,?,?,?,?)').run(instance.id, body.workspace_id, body.project_id, instance.revision, JSON.stringify(instance));
          // The independent authoritative grant is minted with the instance,
          // bound to the exact project generation and the closed scope set for
          // the kind. instance.enabled/revoked stay a UI projection only.
          const grant = {version: 1, id: grantId, workspace_id: body.workspace_id, project_id: body.project_id, instance_id: instance.id, revision: 1, project_generation: proposal.project_generation, scopes: [...(GRANT_SCOPES[proposal.kind] ?? [])], revoked: false, created_at: time, updated_at: time};
          data.db.prepare('INSERT INTO wb_tool_grants(id,workspace_id,project_id,instance_id,revision,record_json) VALUES (?,?,?,?,?,?)').run(grant.id, body.workspace_id, body.project_id, instance.id, grant.revision, JSON.stringify(grant));
          data.db.prepare('INSERT INTO wb_tool_bindings(id,workspace_id,project_id,instance_id,pane_id,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), body.workspace_id, body.project_id, instance.id, proposal.pane_id, time);
          data.db.prepare('UPDATE wb_tool_proposals SET record_json=? WHERE id=?').run(JSON.stringify({...proposal, status: 'committed', op_id: body.op_id, committed_actor: actor, committed_revision: record.revision, checkpoint_id: checkpoint?.id ?? null, updated_at: time}), proposal.id);
          const result = {instance: publicInstance(instance), revision: record.revision, checkpoint_id: checkpoint?.id ?? null, command_receipt: {operation_id: body.op_id, legacy: false}};
          writeReceipt({workspaceId: body.workspace_id, actor, opId: body.op_id, requestHash, intent: body.intent, kind: 'create_commit', result, policyGeneration: record.recovery_policy.generation});
          return result;
        },
      });
    } catch (error) {
      const mapped = asToolError(error);
      if (mapped.code === 'stale_resource' || mapped.code === 'expired') markProposalStale(proposal);
      throw mapped;
    }
    return committed.result;
  }

  async function dispatch(body, {actor = 'owner'} = {}) {
    if (!valid(body)) throw wbError('invalid_request');
    switch (body.action) {
      case 'metadata_list': return metadataList(body);
      case 'resolve': return resolve(body);
      case 'data_read': return dataRead(body);
      case 'data_save': return dataSave(body, actor);
      case 'configure': return configure(body, actor);
      case 'set_enabled': return setEnabled(body, actor);
      case 'revoke': return revoke(body, actor);
      case 'repin': return repin(body, actor);
      case 'create_preview': return createPreview(body, actor);
      case 'create_commit': return createCommit(body, actor);
    }
    throw wbError('invalid_request');
  }

  return {dispatch, metadataList, resolve};
}
