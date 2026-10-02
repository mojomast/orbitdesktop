// Trusted parent-page handoff. Cancellation fences waiting requests only;
// once submitted, the authoritative host selection must finish/reconcile.
export type ConversationSelection = {
  paneId?: string; profileId: string; sessionId: string;
  signal?: AbortSignal;
  report?: (phase: 'waiting' | 'opening' | 'opened' | 'failed', message: string) => void;
};
