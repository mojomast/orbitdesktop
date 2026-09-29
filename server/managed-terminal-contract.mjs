/**
 * FROZEN INTERFACE for user-reachable managed terminals.
 *
 * This module is the single source of truth shared by the server-side provider,
 * the durable identity ledger, the grant/observation broker, the owner HTTP route
 * and the browser UI. It contains pure constants, validators and pure helpers; it
 * performs no I/O, holds no state and must not import any other project module.
 *
 * Changes to this interface require matching route, UI, and acceptance tests.
 *
 * ============================================================================
 * IDENTITY / PLACEMENT MODEL
 * ============================================================================
 * A terminal pane in a workspace has a random 36-char UUID `pane_id` (src/model.ts
 * `id()`). The existing LocalHostProvider names its tmux session `pane-<pane_id>`
 * on the configured socket (`ORBIT_TMUX_SOCKET`, default `orbit-persistent`).
 * The pane id is a placement hint only; it is NEVER proof of the shell's identity.
 *
 * `sessionNameForPane(paneId)` / `paneIdFromSessionName(name)` are the only
 * sanctioned translations. A route must additionally prove the pane id is a
 * terminal leaf of the CURRENT workspace state before any resource action.
 *
 * ============================================================================
 * FROZEN HTTP CONTRACT: POST /api/managed-terminals  (owner bearer + origin)
 * ============================================================================
 * Every request is a JSON object with a string `action`. Request bodies are bounded
 * to MANAGED_TERMINAL_LIMITS.requestBytes. Success responses are
 * `{ ok: true, ... }`. Failures are `{ ok: false, error: <category>, code: <code> }`
 * with a stable HTTP status (see ACTION_ERROR_STATUS in the route module).
 *
 * | action     | request fields                                                                 | response fields |
 * | ---------- | ------------------------------------------------------------------------------ | --------------- |
 * | status     | -                                                                              | generation, resources[], leases[] |
 * | reconcile  | workspace_id                                                                   | entries[] |
 * | adopt      | workspace_id, pane_id, base_revision, consent=true                             | resource |
 * | grant      | workspace_id, pane_id, base_revision, consent=true, scope('observe'|'input'), ttl_ms? | lease |
 * | observe    | workspace_id, lease_id, base_revision, lines?                                  | text, bytes, lines, observed_at |
 * | input      | workspace_id, lease_id, base_revision, text, confirm=true, confirm_newline, operation_id | operation_id, applied |
 * | revoke     | lease_id                                                                       | revoked |
 * | release    | workspace_id, pane_id, base_revision, consent=true, acknowledge=<RELEASE_ACKNOWLEDGEMENT> | released, mode |
 *
 * Redacted shapes (never include tokens, kernel ids, pids or raw tmux output):
 *   resource: { resource_id, pane_id, workspace_id, status }
 *   lease:    { lease_id, scope, resource_id, pane_id, expires_at, state }
 *   entry:    { pane_id, status }
 * status:     { generation, resources: resource[], leases: lease[] }
 * reconcile:  { entries: entry[], reconciled_at }
 * release:    { released: true, mode: 'missing'|'cleared'|'unmanaged' }
 *
 * Allowed `status` values for a reconciled entry:
 *   'managed'           ledger entry + installed markers + matching kernel identity
 *   'unmanaged'         no ledger entry (side-effect-free inspection only)
 *   'missing'           ledger entry but the exact session/pane no longer exists
 *   'identity_changed'  ledger entry but observed incarnation differs (respawn/swap)
 *   'requires_consent'  markers absent (e.g. tmux server restart) -> explicit re-adopt
 *
 * ============================================================================
 * FROZEN MODULE APIs (implemented by the server-core worker)
 * ============================================================================
 *
 * --- server/managed-terminal-ledger.mjs : class ManagedTerminalIdentityLedger ---
 * Durable continuity metadata, persisted SEPARATELY from grants.
 *   new ManagedTerminalIdentityLedger({ directory, filename = 'identity-ledger.json' })
 *     `directory` must already exist, be owned by this uid, mode 0700, not a symlink.
 *   await ledger.load()                    // idempotent; reads + validates; missing file -> empty
 *   ledger.get(sessionName)                // frozen entry | null
 *   ledger.list()                          // frozen entry[] (no live references)
 *   await ledger.put(entry)                // validates + atomic write (0600), fsync
 *   await ledger.remove(sessionName)       // atomic write
 *   ledger.size                            // number
 * Ledger entry (private; never returned by the HTTP route as-is):
 *   { version: 1, sessionName, workspaceId, mode: 'attach',
 *     serverEpoch, shellInstance,                      // random 64-hex provider tokens
 *     sessionId, paneId, serverPid, shellPid,
 *     bootId, serverStarttime, shellStarttime, adoptedAt }
 * Errors: ManagedTerminalLedgerError with a `code` from MANAGED_TERMINAL_ERROR_CODES.
 *
 * --- server/managed-terminal-provider.mjs : extend class ManagedTerminalProvider ---
 * Existing private mode (default) is unchanged and must keep all current tests green.
 * New option `mode: 'attach'` (plus `ledger`) adapts to an EXISTING socket without
 * claiming a namespace and without ever creating, killing or respawning anything.
 *   new ManagedTerminalProvider({ mode: 'attach', socket, ledger, tmuxTmpDir?, timeoutMs?, ... })
 *     `tmuxTmpDir` (optional) selects the ambient TMUX_TMPDIR so the exact existing
 *     default-socket server can be found. Attach env never sets TMUX and never
 *     overrides TMUX_TMPDIR with a private directory; it uses HOME from the process.
 *   static async create(options)                  // loads ledger, no tmux mutation
 *   inspectExact({ sessionName, signal })         // ledger-backed proof | null
 *   observeExact({ sessionName, signal })         // side-effect-free raw observation | null
 *   adoptSession({ sessionName, workspaceId, signal })
 *       // ATTACH ONLY. Inspects the exact existing target, installs random per-session
 *       // markers, re-inspects, persists a ledger entry via ledger.put. Idempotent when
 *       // the ledger entry already matches. Returns null when the observed incarnation
 *       // differs from an existing ledger entry (never overwrites). Never creates.
 *   captureExact({ sessionName, lines, maxBytes, signal })   // bounded read-only | null
 *   sendLiteral({ sessionName, plan, signal })               // plan from literalChunks()
 *   releaseSession({ sessionName, signal, authorize })       // ATTACH ONLY recovery
 *       // Removes the continuity record for the exact session. If the target is
 *       // missing it removes metadata only. If a live target still carries OUR
 *       // known adopted markers it clears exactly those three options in the SAME
 *       // if-shell check; foreign/unknown markers are refused, never overwritten or
 *       // cleared. It NEVER kills or creates a process. Returns
 *       // { mode: 'missing'|'cleared'|'unmanaged' } | null (null = cannot prove).
 *   closeSession({ sessionName })   // ATTACH: fail('unavailable'); never kills owner shells
 *   dispose()                       // ATTACH: never kills any session or server
 * observeExact returns:
 *   { sessionName, sessionId, paneId, serverPid, shellPid,
 *     markers: { serverEpoch, shellInstance, sessionEpoch },
 *     kernel: { bootId, serverStarttime, shellStarttime } } | null
 * inspectExact returns the registry-compatible identity:
 *   { serverEpoch, sessionId, paneId, shellInstance } | null
 * captureExact returns `{ text, bytes }` | null. sendLiteral returns `{ sent }` | null.
 * Attach markers are `@orbit_adopted_epoch`, `@orbit_adopted_shell`,
 * `@orbit_adopted_session_epoch`. Private markers stay `@orbit_managed_*`.
 *
 * --- server/managed-terminal-broker.mjs : class ManagedTerminalBroker ---
 *   new ManagedTerminalBroker({ ownerId, providerId, provider, workspaceRead,
 *                               journalPath?, now? })
 *     `workspaceRead(id)` -> workspace record `{ id, revision, state }` (store.read shape).
 *   status()
 *   reconcile({ workspaceId })
 *   adopt({ workspaceId, paneId, consent })
 *   grant({ workspaceId, paneId, scope, ttlMs })
 *   revoke({ leaseId })
 *   release({ workspaceId, paneId, baseRevision, consent, acknowledge })
 *   observe({ workspaceId, leaseId, baseRevision, lines })
 *   input({ workspaceId, leaseId, baseRevision, text, confirmNewline, operationId })
 * Errors: ManagedTerminalBrokerError with a `code` from MANAGED_TERMINAL_ERROR_CODES.
 * Observations are returned ONLY to the owner route. They must never be attached to
 * workspace events, receipts, plugin/model channels, logs or checkpoints.
 * Broker return shapes are camelCase (the route redacts/renames them):
 *   status()                 -> { generation, resources: [{resourceId, paneId, workspaceId, status}],
 *                                 leases: [{leaseId, scope, resourceId, paneId, expiresAt, state}] }
 *   reconcile({workspaceId}) -> { entries: [{paneId, status}], reconciledAt }
 *   adopt({...})             -> { resourceId, paneId, workspaceId, status: 'managed' }
 *   grant({...})             -> { leaseId, scope, resourceId, paneId, expiresAt, state: 'active' }
 *   observe({...})           -> { text, bytes, lines, observedAt }
 *   input({...})             -> { operationId, applied: true }
 *   revoke({leaseId})        -> { revoked: boolean }
 *   release({...})           -> { released: true, mode: 'missing'|'cleared'|'unmanaged' }
 *   `expiresAt` / `observedAt` / `reconciledAt` are epoch-millisecond integers.
 * The owner route tolerates BOTH camelCase and snake_case keys here (it normalizes
 * with `??`), so a broker may return `resource_id`/`observed_at`/`operation_id`.
 *
 * ============================================================================
 */

export const MANAGED_TERMINAL_ERROR_CODES = Object.freeze([
  'invalid_request',
  'confirmation_required',
  'unauthorized',
  'not_found',
  'conflict',
  'pending',
  'revoked',
  'expired',
  'unavailable',
  'identity_changed',
  'busy',
  'timeout',
  'provider_error',
  'request_too_large',
  'journal_full',
]);

export const MANAGED_TERMINAL_ACTIONS = Object.freeze([
  'status', 'reconcile', 'adopt', 'grant', 'observe', 'input', 'revoke', 'release',
]);

export const MANAGED_TERMINAL_SCOPES = Object.freeze(['observe', 'input']);

// Owner-consented release is a RECOVERY action. Clearing continuity metadata never
// kills the shell; a later explicit Connect may create a NEW shell when the recorded
// target is missing. The exact text must be echoed back by the owner route so the
// consent is unambiguous and cannot be triggered by an ordinary adopt/reload/status.
export const MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT =
  'does not kill shell; next explicit Connect may create a NEW shell if missing';

export const MANAGED_TERMINAL_LIMITS = Object.freeze({
  requestBytes: 16384,
  maxLiteralBytes: 4096,
  minGrantTtlMs: 5000,
  observeDefaultTtlMs: 60000,
  observeMaxTtlMs: 300000,
  inputDefaultTtlMs: 60000,
  inputMaxTtlMs: 120000,
  observeDefaultLines: 200,
  observeMaxLines: 2000,
  observeMaxBytes: 65536,
  maxLeases: 32,
  maxResources: 16,
  providerTimeoutMs: 1000,
  // Durable operation receipts are NEVER compacted (dropping one could permit a
  // duplicate execution). New receipts are refused before dispatch once the
  // journal would exceed the private-ledger reader limit, so the feature fails
  // closed with journal_full instead of becoming unreadable after a restart.
  journalMaxBytes: 4 * 1024 * 1024 - 65536,
});

export const PANE_PATTERN = /^[a-f0-9-]{36}$/;
export const SESSION_PREFIX = 'pane-';
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
// Lease IDs are issued by the broker as 16 random bytes in lowercase hex.
// Consumers import this contract rather than guessing UUID or general-ID syntax.
export const LEASE_ID_PATTERN = /^[a-f0-9]{32}$/;
export const leaseIdSchema = Object.freeze({type:'string',pattern:LEASE_ID_PATTERN.source});
export const isLeaseId = value => typeof value === 'string' && LEASE_ID_PATTERN.test(value);
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class ManagedTerminalContractError extends Error {
  constructor(code) {
    const category = MANAGED_TERMINAL_ERROR_CODES.includes(code) ? code : 'invalid_request';
    super(`Managed terminal contract: ${category}`);
    this.name = 'ManagedTerminalContractError';
    this.code = category;
  }
}

export function contractFail(code) { throw new ManagedTerminalContractError(code); }

export function isPaneId(value) {
  return typeof value === 'string' && PANE_PATTERN.test(value);
}

export function isOperationId(value) {
  return typeof value === 'string' && OPERATION_ID_PATTERN.test(value);
}

export function isIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

export function sessionNameForPane(paneId) {
  if (!isPaneId(paneId)) contractFail('invalid_request');
  return SESSION_PREFIX + paneId;
}

export function paneIdFromSessionName(sessionName) {
  if (typeof sessionName !== 'string' || !sessionName.startsWith(SESSION_PREFIX)) return null;
  const paneId = sessionName.slice(SESSION_PREFIX.length);
  return isPaneId(paneId) ? paneId : null;
}

// Reject control/escape bytes. A newline is only accepted with explicit confirmation.
export function assertLiteralInput(text, { confirmNewline = false } = {}) {
  if (typeof text !== 'string') contractFail('invalid_request');
  if (Buffer.byteLength(text) > MANAGED_TERMINAL_LIMITS.maxLiteralBytes) contractFail('request_too_large');
  let newline = false;
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point === 0x0a) { newline = true; continue; }
    if (point < 0x20 || point === 0x7f) contractFail('invalid_request');
  }
  if (newline && confirmNewline !== true) contractFail('confirmation_required');
  return newline;
}

// Deterministic literal plan: each chunk is sent with `send-keys -l` (no shell
// interpretation); an Enter is a separate `send-keys Enter`. Empty text -> [].
export function literalChunks(text, { confirmNewline = false } = {}) {
  assertLiteralInput(text, { confirmNewline });
  if (text === '') return [];
  const lines = text.split('\n');
  const plan = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== '') plan.push({ text: lines[index], enter: false });
    if (index < lines.length - 1) plan.push({ text: '', enter: true });
  }
  return plan;
}

// A shared, frozen redaction helper so no module accidentally forwards private
// identity tokens (server/shell epochs, pids, kernel starttimes) to a client.
export function redactResource({ resourceId, paneId, workspaceId, status }) {
  return Object.freeze({ resource_id: resourceId, pane_id: paneId, workspace_id: workspaceId, status });
}

export function redactLease({ leaseId, scope, resourceId, paneId, expiresAt, state }) {
  return Object.freeze({ lease_id: leaseId, scope, resource_id: resourceId, pane_id: paneId, expires_at: expiresAt, state });
}
