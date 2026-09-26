import { randomBytes, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { TerminalResourceRegistry } from './terminal-resource-registry.mjs';
import { privateDirectory, readPrivateJSON, writePrivateJSON } from './managed-terminal-ledger.mjs';
import { MANAGED_TERMINAL_ERROR_CODES, MANAGED_TERMINAL_LIMITS as limits, MANAGED_TERMINAL_SCOPES,
  MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT,
  isIdentifier, isPaneId, isOperationId, sessionNameForPane, literalChunks, redactResource, redactLease } from './managed-terminal-contract.mjs';

export class ManagedTerminalBrokerError extends Error {
  constructor(code) {
    code = MANAGED_TERMINAL_ERROR_CODES.includes(code) ? code : 'provider_error';
    super(`Managed terminal broker: ${code}`); this.name = 'ManagedTerminalBrokerError'; this.code = code;
  }
}
const fail = code => { throw new ManagedTerminalBrokerError(code); };
const claims = new Map();
const randomId = () => randomBytes(16).toString('hex');
const matching = (o, e) => o && e && ['sessionName', 'sessionId', 'paneId', 'serverPid', 'shellPid'].every(k => o[k] === e[k]) &&
  Object.keys(o.kernel).every(k => o.kernel[k] === e[k]) && o.markers.serverEpoch === e.serverEpoch &&
  o.markers.sessionEpoch === e.serverEpoch && o.markers.shellInstance === e.shellInstance;
const absentMarkers = o => o && Object.values(o.markers).every(v => v === '');

export class ManagedTerminalBroker {
  #owner; #providerId; #provider; #read; #registries = new Map(); #resources = new Map(); #leases = new Map();
  #generation = 0; #now; #clock = 0; #tick = performance.now(); #journalPath; #journal = {}; #reserved = 0;
  constructor({ ownerId, providerId, provider, workspaceRead, journalPath, now = Date.now }) {
    if (!isIdentifier(ownerId) || !isIdentifier(providerId) || !provider || typeof workspaceRead !== 'function' || typeof now !== 'function') fail('invalid_request');
    this.#owner = ownerId; this.#providerId = providerId; this.#provider = provider; this.#read = workspaceRead; this.#now = now;
    if (journalPath !== undefined) {
      try {
        if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath)) fail('invalid_request');
        privateDirectory(path.dirname(journalPath));
        this.#journal = readPrivateJSON(journalPath) ?? {};
        if (!this.#journal || Array.isArray(this.#journal) || typeof this.#journal !== 'object') fail('provider_error');
        for (const [id, e] of Object.entries(this.#journal)) {
          if (!isOperationId(id) || !e || !/^[a-f0-9]{64}$/.test(e.hash) || !['pending', 'applied', 'failed'].includes(e.state) || Object.keys(e).sort().join(',') !== 'hash,state') fail('provider_error');
        }
        this.#journalPath = journalPath;
      } catch (e) { fail(e.code); }
    }
  }
  async #call(work) { try { return await work(); } catch (e) { if (e instanceof ManagedTerminalBrokerError) throw e; fail(e.code); } }
  #time() { const tick = performance.now(); this.#clock = Math.max(this.#clock + tick - this.#tick, this.#now()); this.#tick = tick; return this.#clock; }
  #workspace(id) {
    if (!isIdentifier(id)) fail('invalid_request');
    const record = this.#read(id);
    if (!record || record.id !== id || !Number.isSafeInteger(record.revision)) fail('not_found');
    return record;
  }
  #panes(record) {
    const result = new Set();
    const walk = node => {
      if (node?.type === 'pane' && node.pane?.kind === 'terminal' && isPaneId(node.pane.id)) result.add(node.pane.id);
      else if (node?.type === 'split') { walk(node.first); walk(node.second); }
    };
    for (const monitor of record.state?.monitors ?? []) walk(monitor.layout);
    return result;
  }
  #contains(workspaceId, paneId) {
    if (!isPaneId(paneId)) fail('invalid_request');
    const record = this.#workspace(workspaceId);
    if (!this.#panes(record).has(paneId)) fail('not_found');
    return record;
  }
  #registry(workspaceId) {
    if (!this.#registries.has(workspaceId)) this.#registries.set(workspaceId, new TerminalResourceRegistry({
      ownerId: this.#owner, workspaceId, providerId: this.#providerId, adapter: this.#provider,
    }));
    return this.#registries.get(workspaceId);
  }
  #resource(workspaceId, paneId) { return [...this.#resources.values()].find(r => r.workspaceId === workspaceId && r.paneId === paneId); }
  #leaseState(lease) { return lease.state === 'revoked' ? 'revoked' : this.#time() >= lease.deadline ? 'expired' : 'active'; }
  status() {
    return { generation: this.#generation, resources: [...this.#resources.values()].map(redactResource),
      leases: [...this.#leases.values()].map(l => redactLease({ ...l, state: this.#leaseState(l) })) };
  }
  async reconcile({ workspaceId }) {
    return this.#call(async () => {
      const entries = [];
      for (const paneId of this.#panes(this.#workspace(workspaceId))) {
        const sessionName = sessionNameForPane(paneId);
        const e = this.#provider.ledger.get(sessionName);
        const o = await this.#provider.observeExact({ sessionName });
        const status = !o ? 'missing' : !e ? 'unmanaged' : absentMarkers(o) ? 'requires_consent' :
          e.workspaceId === workspaceId && matching(o, e) ? 'managed' : 'identity_changed';
        entries.push({ pane_id: paneId, status });
      }
      return { entries, reconciled_at: this.#now() };
    });
  }
  async adopt({ workspaceId, paneId, consent, baseRevision }) {
    return this.#call(async () => {
      if (consent !== true) fail('confirmation_required');
      let generation = this.#generation;
      const check = () => { const record = this.#contains(workspaceId, paneId); if (baseRevision !== undefined && record.revision !== baseRevision) fail('conflict'); if (generation !== this.#generation) fail('revoked'); };
      check();
      const name = sessionNameForPane(paneId);
      const claim = claims.get(name);
      if (claim && (claim.workspaceId !== workspaceId || claim.broker !== this)) fail('conflict');
      // Reserve capacity synchronously BEFORE any await so concurrent adoptions
      // cannot exceed maxResources. Orphans (pane no longer present in a known
      // workspace) are pruned metadata-only before ever reporting busy.
      if (!this.#resource(workspaceId, paneId) && this.#resources.size + this.#reserved >= limits.maxResources) {
        this.#pruneOrphans();
        if (this.#resources.size + this.#reserved >= limits.maxResources) fail('busy');
      }
      this.#reserved++;
      try {
        claims.set(name, { workspaceId, broker: this });
        try {
          const old = this.#provider.ledger.get(name);
          if (old && old.workspaceId !== workspaceId) fail('conflict');
          const observed = await this.#provider.observeExact({ sessionName: name });
          check();
          if (!observed) fail('not_found');
          if (old && !matching(observed, old) && absentMarkers(observed)) {
            // Explicit fresh consent after a server restart; never silently replace a shell with retained markers.
            await this.#provider.ledger.remove(name);
            const resource = this.#resource(workspaceId, paneId);
            if (resource) { this.#revokeResourceLeases(resource.resourceId); this.#registry(workspaceId).revoke(resource.binding); this.#resources.delete(resource.resourceId); this.#generation++; generation = this.#generation; }
          }
          const identity = await this.#provider.adoptSession({ sessionName: name, workspaceId, authorize: check });
          check();
          if (!identity) fail('identity_changed');
          this.#contains(workspaceId, paneId);
          let resource = this.#resource(workspaceId, paneId);
          if (resource) {
            // Repair a registry binding invalidated by an earlier transient
            // inspection so later grants are not permanently blocked. Old leases
            // for this resource are fenced.
            let live = false;
            try { live = !!(await this.#registry(workspaceId).lookup(resource.binding)); } catch { live = false; }
            if (!live) {
              this.#revokeResourceLeases(resource.resourceId);
              this.#registry(workspaceId).revoke(resource.binding);
              this.#generation++; generation = this.#generation;
              const binding = await this.#registry(workspaceId).register({ sessionName: name });
              try { check(); } catch (error) { this.#registry(workspaceId).revoke(binding); throw error; }
              this.#contains(workspaceId, paneId);
              resource = { ...resource, binding };
              this.#resources.set(resource.resourceId, resource);
            }
          } else {
            const binding = await this.#registry(workspaceId).register({ sessionName: name });
            try { check(); } catch (error) { this.#registry(workspaceId).revoke(binding); throw error; }
            this.#contains(workspaceId, paneId);
            resource = { resourceId: randomId(), workspaceId, paneId, status: 'managed', binding };
            this.#resources.set(resource.resourceId, resource);
          }
          return redactResource(resource);
        } catch (e) { if (!this.#resource(workspaceId, paneId)) claims.delete(name); throw e; }
      } finally { this.#reserved--; }
    });
  }
  async grant({ workspaceId, paneId, scope, ttlMs, baseRevision }) {
    return this.#call(async () => {
      const generation = this.#generation;
      const check = () => { const record = this.#contains(workspaceId, paneId); if (baseRevision !== undefined && record.revision !== baseRevision) fail('conflict'); if (generation !== this.#generation) fail('revoked'); };
      check();
      if (!MANAGED_TERMINAL_SCOPES.includes(scope)) fail('invalid_request');
      ttlMs ??= limits[`${scope}DefaultTtlMs`];
      if (!Number.isInteger(ttlMs) || ttlMs < limits.minGrantTtlMs || ttlMs > limits[`${scope}MaxTtlMs`]) fail('invalid_request');
      const resource = this.#resource(workspaceId, paneId);
      if (!resource) fail('not_found');
      if (!await this.#registry(workspaceId).lookup(resource.binding)) fail('identity_changed');
      check();
      this.#contains(workspaceId, paneId);
      for (const [id, l] of this.#leases) if (this.#leaseState(l) !== 'active') this.#leases.delete(id);
      if (this.#leases.size >= limits.maxLeases) fail('busy');
      // Advertised expiry is per-lease; enforcement uses the monotonic deadline.
      const expiresAt = this.#now() + ttlMs;
      const lease = { leaseId: randomId(), scope, resourceId: resource.resourceId, workspaceId, paneId,
        expiresAt, deadline: this.#time() + ttlMs, state: 'active', binding: resource.binding };
      this.#leases.set(lease.leaseId, lease);
      return redactLease(lease);
    });
  }
  revoke({ leaseId }) {
    const lease = this.#leases.get(leaseId);
    if (!lease) fail('not_found');
    // Fence THIS lease only. Its state + monotonic deadline already fail closed for
    // it; bumping the global generation would wrongly abort unrelated in-flight
    // observe/input work on other active leases.
    lease.state = 'revoked';
    return { revoked: true };
  }

  #revokeResourceLeases(resourceId) {
    for (const lease of this.#leases.values()) if (lease.resourceId === resourceId) lease.state = 'revoked';
  }

  // Metadata-only cleanup of resources whose pane is no longer present in a known
  // workspace. Never reads output, adopts, creates or kills a shell. A workspace
  // that cannot be read is never treated as proof of absence.
  #pruneOrphans() {
    for (const [id, resource] of [...this.#resources]) {
      let record = null;
      try { record = this.#workspace(resource.workspaceId); } catch { record = null; }
      if (!record || this.#panes(record).has(resource.paneId)) continue;
      this.#revokeResourceLeases(resource.resourceId);
      this.#registry(resource.workspaceId).revoke(resource.binding);
      this.#resources.delete(id);
      const claim = claims.get(sessionNameForPane(resource.paneId));
      if (claim && claim.broker === this) claims.delete(sessionNameForPane(resource.paneId));
    }
  }

  #releaseResource(workspaceId, paneId) {
    const name = sessionNameForPane(paneId);
    const resource = this.#resource(workspaceId, paneId);
    if (resource) {
      this.#revokeResourceLeases(resource.resourceId);
      this.#registry(workspaceId).revoke(resource.binding);
      this.#resources.delete(resource.resourceId);
    }
    const claim = claims.get(name);
    if (claim && claim.broker === this) claims.delete(name);
    this.#generation++;
  }

  // Explicit owner-consented recovery. Removes continuity metadata with the
  // provider and revokes all resource leases/binding/claim. It NEVER kills a
  // shell and NEVER creates one; a later explicit Connect may create a new shell
  // only when the recorded target is missing.
  async release({ workspaceId, paneId, consent, acknowledge, baseRevision }) {
    return this.#call(async () => {
      if (consent !== true) fail('confirmation_required');
      if (acknowledge !== MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT) fail('confirmation_required');
      let generation = this.#generation;
      const check = () => { const record = this.#contains(workspaceId, paneId); if (baseRevision !== undefined && record.revision !== baseRevision) fail('conflict'); if (generation !== this.#generation) fail('revoked'); };
      check();
      const name = sessionNameForPane(paneId);
      const existing = this.#provider.ledger.get(name);
      if (existing && existing.workspaceId !== workspaceId) fail('conflict');
      if (!existing && !this.#resource(workspaceId, paneId)) fail('not_found');
      const outcome = existing ? await this.#provider.releaseSession({ sessionName: name, authorize: check }) : { mode: 'unmanaged' };
      check();
      if (!outcome) fail('identity_changed');
      this.#releaseResource(workspaceId, paneId);
      return { released: true, mode: outcome.mode };
    });
  }
  #fence(request, scope, generation) {
    const lease = this.#leases.get(request.leaseId);
    if (!lease || lease.workspaceId !== request.workspaceId || lease.scope !== scope) fail('unauthorized');
    const state = this.#leaseState(lease);
    if (state !== 'active') fail(state);
    if (generation !== undefined && generation !== this.#generation) fail('revoked');
    const record = this.#workspace(request.workspaceId);
    if (!Number.isSafeInteger(request.baseRevision) || record.revision !== request.baseRevision) fail('conflict');
    if (!this.#panes(record).has(lease.paneId)) fail('identity_changed');
    if (this.#resources.get(lease.resourceId)?.binding !== lease.binding) fail('identity_changed');
    return lease;
  }
  async #checked(request, scope, generation) {
    const lease = this.#fence(request, scope, generation);
    const binding = await this.#registry(request.workspaceId).lookup(lease.binding);
    this.#fence(request, scope, generation);
    if (binding !== lease.binding) fail('identity_changed');
    return lease;
  }
  async observe(request) {
    request = { ...request };
    return this.#call(async () => {
      const lines = request.lines ?? limits.observeDefaultLines;
      if (!Number.isInteger(lines) || lines < 1 || lines > limits.observeMaxLines) fail('invalid_request');
      const generation = this.#generation;
      const lease = await this.#checked(request, 'observe', generation);
      const capture = await this.#provider.captureExact({ sessionName: lease.binding.sessionName, lines, maxBytes: limits.observeMaxBytes,
        authorize: () => this.#fence(request, 'observe', generation) });
      await this.#checked(request, 'observe', generation);
      if (!capture) fail('identity_changed');
      return { ...capture, lines, observed_at: this.#now() };
    });
  }
  #writeJournal(id, entry) {
    if (!this.#journalPath) fail('unavailable');
    const next = { ...this.#journal, [id]: entry };
    // Receipts are never compacted: dropping one could allow a duplicate
    // execution. Refuse BEFORE dispatch once the journal would exceed the
    // private-ledger reader limit so the feature fails closed with a useful code
    // instead of becoming unreadable after a restart.
    if (JSON.stringify(next).length > limits.journalMaxBytes) fail('journal_full');
    writePrivateJSON(this.#journalPath, next); this.#journal = next;
  }
  async input(request) {
    request = { ...request };
    return this.#call(async () => {
      const { operationId, text, confirmNewline } = request;
      if (!isOperationId(operationId)) fail('invalid_request');
      const plan = literalChunks(text, { confirmNewline });
      const generation = this.#generation;
      const lease = await this.#checked(request, 'input', generation);
      const hash = createHash('sha256').update(JSON.stringify([request.workspaceId, request.leaseId, request.baseRevision, text, confirmNewline === true])).digest('hex');
      const existing = Object.hasOwn(this.#journal, operationId) ? this.#journal[operationId] : null;
      if (existing) {
        if (existing.hash !== hash) fail('conflict');
        if (existing.state !== 'applied') fail('pending');
        return { operation_id: operationId, applied: true };
      }
      this.#writeJournal(operationId, { hash, state: 'pending' });
      const sent = await this.#provider.sendLiteral({ sessionName: lease.binding.sessionName, plan,
        authorize: () => this.#fence(request, 'input', generation) });
      await this.#checked(request, 'input', generation);
      if (!sent?.sent) fail('identity_changed');
      this.#writeJournal(operationId, { hash, state: 'applied' });
      return { operation_id: operationId, applied: true };
    });
  }
}
