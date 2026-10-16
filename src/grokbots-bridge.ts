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
  return () => { frames.delete(context); window.removeEventListener('message', onMessage); frame.removeEventListener('load', hello); dispatchEvent(new CustomEvent('orbit-grokbots-unbound', { detail: { frame } })); };
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
