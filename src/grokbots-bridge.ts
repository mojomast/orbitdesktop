// Host side of the built-in Grok Bots app (apps/grokbots/index.html).
//
// The app runs in an opaque-origin sandboxed iframe and only holds its own
// capability key, so features that need the Orbit host (document review, desktop
// notifications, opening windows, voice transcripts, clipboard fallback) go
// through this postMessage bridge. Only frames whose src is this origin's
// /apps/grokbots/ are bound, and a message is accepted only when its source is
// that exact frame's window. The bridge never hands the Orbit token, workspace
// state or other conversations to the app; every op is explicit and bounded.
import { workspaceId } from './workspace-sync';
import { registerConversationRecipient, type ConversationRecipientHandle } from './conversation-transfer';

export const GROKBOTS_PATH = '/apps/grokbots/';
const MAX_TEXT = 500_000;

export type GrokBotsMessage = { type: 'grokbots'; op: string; id?: string; [key: string]: unknown };
export type GrokBotsFrameContext = {
  frame: HTMLIFrameElement;
  /** Fire-and-forget message to this app frame. */
  post(message: Record<string, unknown>): void;
};
type Handler = (message: GrokBotsMessage, context: GrokBotsFrameContext) => unknown | Promise<unknown>;
const handlers = new Map<string, Handler>();
const frames = new Set<GrokBotsFrameContext>();
const recipients = new Map<GrokBotsFrameContext, ConversationRecipientHandle | null>();
type InsertResult = { accepted: true } | { accepted: false; reason?: string };
const pendingInserts = new Map<string, (result: InsertResult) => void>();

/** Register (or replace) the host implementation of one bridge op. */
export function registerGrokBotsOp(op: string, handler: Handler) { handlers.set(op, handler); }
/** Every currently bound Grok Bots frame (for host → app broadcasts). */
export function grokBotsFrames(): GrokBotsFrameContext[] { return [...frames].filter(f => f.frame.isConnected); }

export function isGrokBotsUrl(src: string): boolean {
  try { const url = new URL(src, location.origin); return url.origin === location.origin && url.pathname.startsWith(GROKBOTS_PATH); } catch { return false; }
}
export const clipText = (value: unknown, max = MAX_TEXT) => (typeof value === 'string' ? value : '').slice(0, max);

export function features() {
  return {
    documents: true,
    notifications: 'Notification' in window ? Notification.permission : 'unsupported',
    voice: true,
    windows: true,
  };
}

export function bindGrokBots(frame: HTMLIFrameElement): () => void {
  if (!isGrokBotsUrl(frame.src)) return () => {};
  const context: GrokBotsFrameContext = {
    frame,
    post(message) { frame.contentWindow?.postMessage({ type: 'grokbots-host', ...message }, '*'); },
  };
  frames.add(context);
  // Each Grok Bots window is a "Choose draft…" target for voice transcripts and
  // other conversation transfers. Text lands in the app's composer draft only;
  // the app never sends it on its own.
  let recipient: ConversationRecipientHandle | null = null;
  try {
    recipient = registerConversationRecipient({
      id: `grokbots:${crypto.randomUUID()}`, title: 'Grok Bots', available: false,
      receive: delivery => new Promise(resolve => {
        const id = `ins-${crypto.randomUUID()}`;
        const timer = setTimeout(() => { pendingInserts.delete(id); resolve({ accepted: false, reason: 'Grok Bots did not answer. Reload its window.' }); }, 5000);
        pendingInserts.set(id, result => { clearTimeout(timer); resolve(result); });
        context.post({ op: 'insert', id, text: delivery.text, title: delivery.title || '', source: delivery.source || '', truncated: delivery.truncated });
      }),
    });
  } catch { recipient = null; }
  recipients.set(context, recipient);
  const hello = () => context.post({ op: 'hello', workspaceId, features: features() });
  const onMessage = async (event: MessageEvent) => {
    if (!frame.contentWindow || event.source !== frame.contentWindow) return;
    const data = event.data as GrokBotsMessage;
    if (!data || typeof data !== 'object' || data.type !== 'grokbots' || typeof data.op !== 'string') return;
    if (data.op === 'hello') { hello(); return; }
    const handler = handlers.get(data.op);
    const re = typeof data.id === 'string' ? data.id.slice(0, 64) : undefined;
    if (!handler) { if (re) context.post({ re, ok: false, error: 'Orbit does not support this request.' }); return; }
    try {
      const result = await handler(data, context);
      if (re) context.post({ re, ok: true, data: result ?? null });
    } catch (error) {
      if (re) context.post({ re, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  window.addEventListener('message', onMessage);
  frame.addEventListener('load', hello);
  return () => { recipients.get(context)?.dispose(); recipients.delete(context); frames.delete(context); window.removeEventListener('message', onMessage); frame.removeEventListener('load', hello); dispatchEvent(new CustomEvent('orbit-grokbots-unbound', { detail: { frame } })); };
}

// ---- built-in ops ---------------------------------------------------------

// Clipboard fallback when the sandboxed frame cannot write the clipboard itself.
registerGrokBotsOp('copy', async message => {
  const text = clipText(message.text);
  if (!text) throw Error('Nothing to copy.');
  await navigator.clipboard.writeText(text);
});

// "Create document from result": the same owner review the agent chat uses
// (orbit-review-document-result → document library review dialog). Nothing is
// saved until the owner accepts the draft there.
registerGrokBotsOp('document', async (message, context) => {
  const text = clipText(message.text);
  if (!text.trim()) throw Error('This message has no text.');
  const title = (clipText(message.title, 100).trim() || 'Grok Bots reply').replace(/[\u0000-\u001f]+/g, ' ');
  const { importDocument } = await import('./document-artifacts');
  const data = await importDocument(text, 'markdown');
  return await new Promise(resolve => {
    const event = new CustomEvent('orbit-review-document-result', { cancelable: true, detail: { title, data, workspaceId, deliveryId: crypto.randomUUID(), isCurrent: () => context.frame.isConnected, respond: resolve } });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) resolve({ status: 'rejected', reason: 'Connect the host to create documents.' });
  });
});

// Open a conversation in its own Grok Bots window (main.ts listens for orbit-grokbots-open).
const OPEN_ID = /^[A-Za-z0-9_:.@|-]{1,200}$/;
registerGrokBotsOp('open', async message => {
  const profile = clipText(message.profile, 80), agent = clipText(message.agent, 200), session = clipText(message.session, 200);
  if (!OPEN_ID.test(profile) || !OPEN_ID.test(agent) || (session && !OPEN_ID.test(session))) throw Error('Invalid conversation.');
  const event = new CustomEvent('orbit-grokbots-open', { cancelable: true, detail: { profile, agent, session: session || '', newWindow: message.newWindow !== false } });
  window.dispatchEvent(event);
  if (!event.defaultPrevented) throw Error('Orbit cannot open windows here.');
  return { opened: true };
});

// Workbench: owner-approved, recipient-bound context stays in Workbench panes
// (server/workbench-context.mjs); Grok Bots can only open a Workbench window.
registerGrokBotsOp('workbench', async () => {
  window.dispatchEvent(new CustomEvent('orbit-open-workbench-window', { detail: {} }));
  return { opened: true };
});

// Desktop notifications, the same Notification API the agent chat uses. The app
// decides when (turn finished while unseen); the host only shows bounded text.
registerGrokBotsOp('notify', async (message, context) => {
  if (!('Notification' in window)) return { shown: false, reason: 'unsupported' };
  if (Notification.permission !== 'granted') return { shown: false, reason: Notification.permission };
  const title = clipText(message.title, 120).replace(/[\u0000-\u001f]+/g, ' ').trim() || 'Grok Bots';
  const body = clipText(message.body, 300).replace(/[\u0000-\u0008\u000b-\u001f]+/g, ' ');
  const tag = clipText(message.tag, 200);
  const n = new Notification(title, { body, ...(tag ? { tag: `grokbots:${tag}` } : {}) });
  n.onclick = () => { window.focus(); context.frame.scrollIntoView?.({ block: 'nearest' }); context.post({ op: 'notification-click', tag }); n.close(); };
  return { shown: true };
});
registerGrokBotsOp('notify-permission', async () => {
  if (!('Notification' in window)) return { permission: 'unsupported' };
  if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
  return { permission: Notification.permission };
});

// Voice input: open Orbit's local voice capture (Moonshine, on-device). Its
// "Choose draft…" lists each Grok Bots window as a recipient (above).
registerGrokBotsOp('voice', async () => {
  window.dispatchEvent(new CustomEvent('orbit-open-host-surface', { detail: { id: 'voice' } }));
  return { opened: true };
});
// The app reports its current conversation so the recipient list can name it.
registerGrokBotsOp('conversation', async (message, context) => {
  const title = clipText(message.title, 80).replace(/[\u0000-\u001f]+/g, ' ').trim();
  recipients.get(context)?.update({ title: title ? `Grok Bots · ${title}` : 'Grok Bots', available: message.available === true });
});
registerGrokBotsOp('insert-ack', async message => {
  const ref = clipText(message.ref, 80); const done = pendingInserts.get(ref);
  if (!done) return;
  pendingInserts.delete(ref);
  done(message.accepted === true ? { accepted: true } : { accepted: false, reason: clipText(message.reason, 200) || 'Grok Bots did not accept the text.' });
});
