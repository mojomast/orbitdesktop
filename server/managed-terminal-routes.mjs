import { allowedRequest, tokenMatches } from './security.mjs';
import {
  MANAGED_TERMINAL_ACTIONS, MANAGED_TERMINAL_LIMITS, MANAGED_TERMINAL_SCOPES,
  MANAGED_TERMINAL_ERROR_CODES, MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT,
  assertLiteralInput, isIdentifier, isOperationId,
  isPaneId, redactLease, redactResource,
} from './managed-terminal-contract.mjs';

export const ACTION_ERROR_STATUS = Object.freeze({
  invalid_request: 400, request_too_large: 413, confirmation_required: 409,
  unauthorized: 401, not_found: 404, conflict: 409, pending: 409,
  identity_changed: 409, unavailable: 409, revoked: 410, expired: 410,
  busy: 429, timeout: 504, provider_error: 502, journal_full: 507,
});

const fail = code => { throw Object.assign(new Error('Managed terminal request rejected'), { code }); };
const required = (value, check) => { if (!check(value)) fail('invalid_request'); return value; };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const resource = value => redactResource({ resourceId: value.resource_id ?? value.resourceId, paneId: value.pane_id ?? value.paneId, workspaceId: value.workspace_id ?? value.workspaceId, status: value.status });
const lease = value => redactLease({ leaseId: value.lease_id ?? value.leaseId, scope: value.scope, resourceId: value.resource_id ?? value.resourceId, paneId: value.pane_id ?? value.paneId, expiresAt: value.expires_at ?? value.expiresAt, state: value.state });

export function createManagedTerminalHandler({ broker, token, port, devOrigins, reply }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const error = code => reply(res, ACTION_ERROR_STATUS[code] || 502, { ok: false, error: code, code });
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'invalid_request', code: 'invalid_request' });
    const authorization = req.headers.authorization || '';
    if (!allowedRequest(req, port, devOrigins) || !authorization.startsWith('Bearer ') || !tokenMatches(authorization.slice(7), token))
      return reply(res, 403, { ok: false, error: 'unauthorized', code: 'unauthorized' });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MANAGED_TERMINAL_LIMITS.requestBytes) return error('request_too_large');
        chunks.push(bytes);
      }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { fail('invalid_request'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !MANAGED_TERMINAL_ACTIONS.includes(body.action)) fail('invalid_request');
      const fields = { status: [], reconcile: ['workspace_id'], adopt: ['workspace_id','pane_id','consent','base_revision'],
        grant: ['workspace_id','pane_id','scope','ttl_ms','consent','base_revision'], observe: ['workspace_id','lease_id','base_revision','lines'],
        input: ['workspace_id','lease_id','base_revision','operation_id','confirm_newline','confirm','text'], revoke: ['lease_id'],
        release: ['workspace_id','pane_id','base_revision','consent','acknowledge'] };
      if (Object.keys(body).some(key => key !== 'action' && !fields[body.action].includes(key))) fail('invalid_request');
      const workspaceId = () => required(body.workspace_id, isIdentifier);
      const paneId = () => required(body.pane_id, isPaneId);
      const leaseId = () => required(body.lease_id, isIdentifier);
      let result;
      switch (body.action) {
        case 'status': {
          const current = await broker.status();
          result = { generation: current.generation, resources: current.resources.map(resource), leases: current.leases.map(lease) };
          break;
        }
        case 'reconcile': {
          const current = await broker.reconcile({ workspaceId: workspaceId() });
          result = { entries: current.entries.map(entry => ({ pane_id: entry.pane_id ?? entry.paneId, status: entry.status })), reconciled_at: current.reconciled_at ?? current.reconciledAt };
          break;
        }
        case 'adopt': {
          const id = workspaceId(), pane = paneId();
          if (body.consent !== true) fail('confirmation_required');
          required(body.base_revision, integer);
          result = { resource: resource(await broker.adopt({ workspaceId: id, paneId: pane, consent: true, baseRevision: body.base_revision })) };
          break;
        }
        case 'grant': {
          const id = workspaceId(), pane = paneId();
          if (body.consent !== true) fail('confirmation_required');
          required(body.base_revision, integer);
          required(body.scope, value => MANAGED_TERMINAL_SCOPES.includes(value));
          if (body.ttl_ms !== undefined) required(body.ttl_ms, value => positive(value) && value >= MANAGED_TERMINAL_LIMITS.minGrantTtlMs && value <= MANAGED_TERMINAL_LIMITS[body.scope === 'observe' ? 'observeMaxTtlMs' : 'inputMaxTtlMs']);
          result = { lease: lease(await broker.grant({ workspaceId: id, paneId: pane, scope: body.scope, ttlMs: body.ttl_ms, baseRevision: body.base_revision })) };
          break;
        }
        case 'observe': {
          const id = workspaceId(), lid = leaseId();
          required(body.base_revision, integer);
          if (body.lines !== undefined) required(body.lines, value => positive(value) && value <= MANAGED_TERMINAL_LIMITS.observeMaxLines);
          const observed = await broker.observe({ workspaceId: id, leaseId: lid, baseRevision: body.base_revision, lines: body.lines });
          result = { text: observed.text, bytes: observed.bytes, lines: observed.lines, observed_at: observed.observed_at ?? observed.observedAt };
          break;
        }
        case 'input': {
          const id = workspaceId(), lid = leaseId();
          if (body.confirm !== true) fail('confirmation_required');
          required(body.base_revision, integer);
          required(body.operation_id, isOperationId);
          required(body.confirm_newline, value => typeof value === 'boolean');
          assertLiteralInput(body.text, { confirmNewline: body.confirm_newline });
          const applied = await broker.input({ workspaceId: id, leaseId: lid, baseRevision: body.base_revision, text: body.text, confirmNewline: body.confirm_newline, operationId: body.operation_id });
          result = { operation_id: applied.operation_id ?? applied.operationId, applied: applied.applied };
          break;
        }
        case 'revoke': {
          const revoked = await broker.revoke({ leaseId: leaseId() });
          result = { revoked: revoked.revoked };
          break;
        }
        case 'release': {
          const id = workspaceId(), pane = paneId();
          if (body.consent !== true) fail('confirmation_required');
          required(body.base_revision, integer);
          if (body.acknowledge !== MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT) fail('confirmation_required');
          const released = await broker.release({ workspaceId: id, paneId: pane, consent: true, acknowledge: body.acknowledge, baseRevision: body.base_revision });
          result = { released: released.released === true, mode: released.mode };
          break;
        }
      }
      return reply(res, 200, { ok: true, ...result });
    } catch (cause) {
      const code = MANAGED_TERMINAL_ERROR_CODES.includes(cause?.code) ? cause.code : 'provider_error';
      return error(code);
    }
  };
}
