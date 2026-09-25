import { allowedRequest, tokenMatches } from './security.mjs';

const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maxBodyBytes = 4096;
const maxResponseBytes = 2_000_000;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createWorkspaceEvents({ store, token, port, devOrigins, reply }) {
  const send = (res, status, body) => reply(res, status, status >= 400 ? { category: { 400: 'INVALID_OPERATION', 403: 'PERMISSION_REQUIRED', 404: 'RESOURCE_GONE', 413: 'REQUEST_TOO_LARGE', 503: 'STORE_UNAVAILABLE' }[status], ...body } : body);

  return async function handle(req, res, control = false) {
    if (!control && (!allowedRequest(req, port, devOrigins) || !tokenMatches((req.headers.authorization || '').replace(/^Bearer /, ''), token))) {
      return send(res, 403, { error: 'Workspace authentication required' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) return send(res, 413, { error: 'Workspace request too large' });
        chunks.push(chunk);
      }
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      return send(res, 400, { error: 'Invalid JSON' });
    }
    if (!object(body) || Object.keys(body).some(key => !['workspace_id', 'cursor', 'limit'].includes(key)) ||
        !idPattern.test(body.workspace_id) || (body.cursor !== undefined && !integer(body.cursor)) ||
        (body.limit !== undefined && (!integer(body.limit, 1) || body.limit > 100))) {
      return send(res, 400, { error: 'Invalid workspace event request' });
    }

    try {
      const record = store.read(body.workspace_id);
      if (control && !tokenMatches((req.headers.authorization || '').replace(/^Bearer /, ''), record.capability)) {
        return send(res, 403, { error: 'Workspace capability required' });
      }
      const page = store.eventPage(body.workspace_id, body.cursor ?? 0, body.limit ?? 100);
      if (!object(page) || !Array.isArray(page.events) || page.events.length > (body.limit ?? 100) ||
          !integer(page.cursor) || typeof page.has_more !== 'boolean' || typeof page.reset_required !== 'boolean') throw Error('Invalid event page');
      const events = page.events.map(event => {
        const payload = event?.payload;
        if (!integer(event?.sequence, 1) || typeof event.type !== 'string' || event.type.length > 100 ||
            !integer(event.timestamp) || typeof event.causation_id !== 'string' || event.causation_id.length > 256 ||
            typeof event.correlation_id !== 'string' || event.correlation_id.length > 256 ||
            !object(payload) || typeof payload.action !== 'string' ||
            !integer(payload.revision) || typeof payload.changed !== 'boolean' ||
            (payload.recovery_policy !== undefined && (!object(payload.recovery_policy) ||
              typeof payload.recovery_policy.held !== 'boolean' || !integer(payload.recovery_policy.generation)))) throw Error('Invalid event');
        return { sequence: event.sequence, type: event.type, timestamp: event.timestamp,
          causation_id: event.causation_id, correlation_id: event.correlation_id,
          payload: { action: payload.action, revision: payload.revision, changed: payload.changed,
            ...(payload.recovery_policy === undefined ? {} : { recovery_policy: {
              held: payload.recovery_policy.held, generation: payload.recovery_policy.generation,
            } }) } };
      });
      const result = { workspace_id: body.workspace_id, events, cursor: page.cursor,
        has_more: page.has_more, reset_required: page.reset_required };
      if (Buffer.byteLength(JSON.stringify(result)) > maxResponseBytes) return send(res, 413, { error: 'Workspace response exceeds the byte budget' });
      return send(res, 200, result);
    } catch (error) {
      if (error.code === 'ENOENT' || error.category === 'RESOURCE_GONE') {
        return control ? send(res, 403, { error: 'Workspace capability required' }) : send(res, 404, { error: 'Workspace is not connected' });
      }
      return send(res, 503, { error: 'Workspace events unavailable' });
    }
  };
}
