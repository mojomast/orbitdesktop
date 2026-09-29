export interface WorkspaceEvent {
  sequence: number;
  type: string;
  timestamp: number;
  causation_id: string;
  correlation_id: string;
  payload: {
    action: string;
    revision: number;
    changed: boolean;
    recovery_policy?: { held: boolean; generation: number };
  };
}

interface EventPage {
  workspace_id: string;
  events: WorkspaceEvent[];
  cursor: number;
  has_more: boolean;
  reset_required: boolean;
}

const PAGE_LIMIT = 100;
const MAX_PAGES_PER_POLL = 4;
const POLL_INTERVAL_MS = 1200;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 2_000_000;

async function readPage(response: Response): Promise<unknown> {
  const reader=response.body?.getReader();
  if(!reader)throw Error('Missing workspace events body');
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let size=0,text='';
  try {
    for(;;) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>MAX_RESPONSE_BYTES){await reader.cancel();throw Error('Workspace events response exceeds byte budget');}
      text+=decoder.decode(value,{stream:true});
    }
    return JSON.parse(text+decoder.decode());
  } finally {reader.releaseLock();}
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function shortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function metadataId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256;
}

function parsePage(value: unknown, workspaceId: string, cursor: number): EventPage {
  if (!object(value) || value.workspace_id !== workspaceId || !Array.isArray(value.events) ||
      value.events.length > PAGE_LIMIT || !sequence(value.cursor) ||
      typeof value.has_more !== 'boolean' || typeof value.reset_required !== 'boolean') {
    throw Error('Invalid workspace events response');
  }
  const page = value as unknown as EventPage;
  if (page.reset_required) {
    if (page.events.length || page.has_more) throw Error('Invalid workspace events reset');
    return page;
  }
  let previous = cursor;
  for (const event of page.events) {
    if (!object(event) || !sequence(event.sequence) || event.sequence <= previous ||
        !shortString(event.type) || !sequence(event.timestamp) ||
        !metadataId(event.causation_id) || !metadataId(event.correlation_id) ||
        !object(event.payload) || !shortString(event.payload.action) ||
        !sequence(event.payload.revision) || typeof event.payload.changed !== 'boolean') {
      throw Error('Invalid workspace event');
    }
    if (event.payload.recovery_policy !== undefined &&
        (!object(event.payload.recovery_policy) ||
         typeof event.payload.recovery_policy.held !== 'boolean' ||
         !sequence(event.payload.recovery_policy.generation))) {
      throw Error('Invalid workspace event recovery policy');
    }
    previous = event.sequence;
  }
  if (page.cursor !== previous || (page.has_more && page.events.length === 0)) {
    throw Error('Invalid workspace events cursor');
  }
  return {...page,events:page.events.map(event=>({sequence:event.sequence,type:event.type,timestamp:event.timestamp,causation_id:event.causation_id,correlation_id:event.correlation_id,payload:{action:event.payload.action,revision:event.payload.revision,changed:event.payload.changed,...(event.payload.recovery_policy?{recovery_policy:{held:event.payload.recovery_policy.held,generation:event.payload.recovery_policy.generation}}:{})}}))};
}

/** Poll finite pages of advisory event metadata; the normal workspace read remains authoritative. */
export function connectWorkspaceEvents({ workspaceId, getToken, onChange, onReset, status }: {
  workspaceId: string;
  getToken: () => string;
  onChange: (event: WorkspaceEvent) => void;
  onReset: () => void;
  status?: (message: string) => void;
}): { close: () => void; poll: () => Promise<void> } {
  let cursor = 0;
  let lastToken = '';
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let active: Promise<void> | undefined;
  let failed = false;
  let resetNotified = false;

  function schedule() {
    if (!closed) timer = setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
  }

  function poll(): Promise<void> {
    if (closed) return Promise.resolve();
    if (active) return active;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    active = (async () => {
      try {
        const token = getToken();
        if (!token) return;
        if (token !== lastToken) {
          cursor = 0;
          resetNotified = false;
          lastToken = token;
        }
        for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_POLL && !closed; pageNumber++) {
          controller = new AbortController();
          const timeout = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
          let response: Response;
          try {
            response = await fetch('/api/workspace/events', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ workspace_id: workspaceId, cursor, limit: PAGE_LIMIT }),
              signal: controller.signal,
            });
            if (!response.ok) throw Error('Workspace events request failed');
            const page = parsePage(await readPage(response), workspaceId, cursor);
            if (closed || getToken() !== token) return;
            if (page.reset_required) {
              if (!resetNotified) onReset();
              resetNotified = true;
              cursor = page.cursor;
              break;
            }
            resetNotified = false;
            for (const event of page.events) {
              if (closed) return;
              cursor = event.sequence;
              try {onChange(event);}catch {
                // Advisory invalidation must not wedge forever on one consumer.
                // Ask for authoritative state; a failed reset is reported below.
                onReset();throw Error('Workspace event consumer failed; snapshot reset requested');
              }
            }
            cursor = page.cursor;
            if (!page.has_more) break;
          } finally {
            clearTimeout(timeout);
            controller = undefined;
          }
        }
        if (failed && !closed) status?.('Workspace events reconnected');
        failed = false;
      } catch {
        if (!closed && !failed) status?.('Workspace events unavailable; retrying');
        failed = true;
      }
    })().finally(() => {
      active = undefined;
      schedule();
    });
    return active;
  }

  schedule();
  return {
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      controller?.abort();
    },
    poll,
  };
}
