import { el, button } from './dom';
import './conversation-transfer.css';

/**
 * Hard cap on transferred characters. Text beyond this is reported to the user
 * and never silently dropped. The full requested length is still delivered to
 * the chosen recipient as `originalLength`, and `truncated` is set.
 */
export const MAX_TRANSFER_CHARS = 20000;

/** Exact text a trusted caller captured. This module never reads a selection itself. */
export interface ConversationTransferRequest {
  /** Recheck source authority immediately before final draft insertion. */
  validate?: () => void | Promise<void>;
  /** Exact text to transfer. Required; empty/whitespace-only text is refused. */
  text: string;
  /** Optional short label shown above the preview. Not part of the transferred text. */
  title?: string;
  /** Optional provenance label such as "workspace selection". Never dereferenced or fetched. */
  source?: string;
}

/** Payload handed to exactly one chosen recipient's `receive`. */
export interface ConversationDelivery {
  /** Bounded text, length <= MAX_TRANSFER_CHARS. */
  text: string;
  /** Full length of the requested text before bounding. */
  originalLength: number;
  /** True when the requested text exceeded MAX_TRANSFER_CHARS. */
  truncated: boolean;
  title?: string;
  source?: string;
}

/**
 * Result of a recipient's async acceptance. `accepted: false` must mean the
 * recipient did not change its conversation; the preview then stays open.
 */
export type ConversationDeliveryResult =
  | { accepted: true }
  | { accepted: false; reason?: string };

export interface ConversationRecipientOptions {
  /** Capture an exact final draft and a race-checked commit, without mutation. */
  prepare?: (delivery: ConversationDelivery) => { text: string; commit: () => ConversationDeliveryResult };
  /** Stable recipient id, 1-128 characters. Re-registering replaces the entry. */
  id: string;
  /** Human label shown in the target list. */
  title: string;
  /** Current eligibility; may change through the update handle. Defaults to true. */
  available?: boolean;
  /**
   * Validates this recipient's exact capture binding against its live
   * conversation and inserts into that draft. May be async. Must not mutate the
   * conversation when it returns `accepted: false`.
   */
  receive: (
    delivery: ConversationDelivery,
  ) => ConversationDeliveryResult | Promise<ConversationDeliveryResult>;
}

/** Returned by registerConversationRecipient. Invalid after dispose(). */
export interface ConversationRecipientHandle {
  readonly id: string;
  update(patch: { title?: string; available?: boolean }): void;
  /** Idempotent; after dispose this recipient is never delivered to again. */
  dispose(): void;
}

export interface ConversationRecipientSummary {
  id: string;
  title: string;
  available: boolean;
}

export type ConversationTransferOutcome =
  | { status: 'delivered'; recipientId: string }
  | { status: 'cancelled' }
  | { status: 'rejected'; recipientId: string; reason: string }
  | { status: 'stale'; recipientId: string; reason: string }
  | { status: 'empty' }
  | { status: 'no-recipient' }
  | { status: 'busy' };

interface RecipientEntry {
  prepare?: ConversationRecipientOptions['prepare'];
  id: string;
  title: string;
  available: boolean;
  receive: ConversationRecipientOptions['receive'];
}

const MAX_ID = 128;
const MAX_LABEL = 200;

// Registry and single-open-dialog state live in memory only. Nothing here is
// persisted, broadcast or exposed to generated frames.
const recipients = new Map<string, RecipientEntry>();
let activeDialog: HTMLDialogElement | null = null;

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Registers a trusted conversation pane as a possible transfer recipient.
 * Delivery goes only to the single recipient the user selects, and only while
 * this registration is current and `available`.
 */
export function registerConversationRecipient(options: ConversationRecipientOptions): ConversationRecipientHandle {
  if (!options || typeof options.id !== 'string' || !options.id || options.id.length > MAX_ID) {
    throw new Error('A conversation recipient needs a stable id of 1-128 characters.');
  }
  if (typeof options.receive !== 'function') {
    throw new Error('A conversation recipient needs a receive callback.');
  }
  const entry: RecipientEntry = {
    id: options.id,
    title: typeof options.title === 'string' && options.title ? clip(options.title, MAX_LABEL) : options.id,
    available: options.available !== false,
    receive: options.receive,
    prepare: options.prepare,
  };
  recipients.set(entry.id, entry);
  return {
    id: entry.id,
    update(patch) {
      // An old handle must never mutate a newer registration for the same id.
      if (recipients.get(entry.id) !== entry) return;
      if (patch && typeof patch.title === 'string' && patch.title) entry.title = clip(patch.title, MAX_LABEL);
      if (patch && typeof patch.available === 'boolean') entry.available = patch.available;
    },
    dispose() {
      if (recipients.get(entry.id) === entry) recipients.delete(entry.id);
    },
  };
}

/** Snapshot of the registered recipients; used by callers to gate a command. */
export function listConversationRecipients(): ConversationRecipientSummary[] {
  return [...recipients.values()].map(({ id, title, available }) => ({ id, title, available }));
}

/**
 * Opens a host dialog that previews the caller's exact bounded text and lets the
 * user pick one registered, available conversation to insert it into. The dialog
 * itself never sends the text to a model, fetches a URL, creates a grant or
 * switches a binding.
 */
export function requestConversationContext(request: ConversationTransferRequest): Promise<ConversationTransferOutcome> {
  const rawText = request && typeof request.text === 'string' ? request.text : '';
  if (!rawText.trim()) return Promise.resolve({ status: 'empty' });
  if (activeDialog) {
    activeDialog.focus();
    return Promise.resolve({ status: 'busy' });
  }

  const boundedText = rawText.slice(0, MAX_TRANSFER_CHARS);
  const truncated = rawText.length > MAX_TRANSFER_CHARS;
  const omitted = rawText.length - boundedText.length;
  const title = typeof request.title === 'string' && request.title ? clip(request.title, MAX_LABEL) : '';
  const source = typeof request.source === 'string' && request.source ? clip(request.source, MAX_LABEL) : '';
  // Snapshot entries by identity. A re-registration replaces the map value, so a
  // snapshot entry that is no longer current is treated as stale and refused.
  const snapshot = new Map(recipients);
  const active = [...snapshot.values()].filter(entry => entry.available);

  return new Promise<ConversationTransferOutcome>(resolve => {
    let closed = false;
    let delivering = false;
    let selectedId = '';
    let prepared: ReturnType<NonNullable<ConversationRecipientOptions['prepare']>> | undefined;
    // The outcome is decided when the dialog actually closes. A successful
    // delivery wins; otherwise the last insert failure is reported, or a plain
    // cancel. With no eligible recipient the only possible close is a refusal.
    let delivered: Extract<ConversationTransferOutcome, { status: 'delivered' }> | null = null;
    let failure: Extract<ConversationTransferOutcome, { status: 'rejected' | 'stale' }> | null = null;
    const refuse = (): ConversationTransferOutcome =>
      active.length ? (failure ?? { status: 'cancelled' }) : { status: 'no-recipient' };

    const dialog = document.createElement('dialog');
    dialog.className = 'conversation-transfer';
    dialog.setAttribute('aria-label', 'Send text to a conversation');

    const preview = el('pre', 'conversation-transfer-preview', boundedText);
    preview.setAttribute('aria-label', 'Text to transfer');
    preview.tabIndex = 0;

    const status = el('p', 'conversation-transfer-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const cancel = button('Cancel', 'Cancel this transfer; nothing is inserted', () => {
      dialog.close();
    });
    cancel.classList.add('conversation-transfer-cancel');
    // Stable accessible names that match the visible labels.
    cancel.setAttribute('aria-label', 'Cancel');

    const insert = button('Insert into draft', 'Insert the previewed text into the selected conversation draft without sending it', () => {});
    insert.classList.add('conversation-transfer-insert');
    insert.setAttribute('aria-label', 'Insert into draft');

    const fieldset = el('fieldset', 'conversation-transfer-targets');
    fieldset.append(el('legend', '', 'Choose a conversation'));
    if (!active.length) {
      fieldset.append(el('p', 'conversation-transfer-none', 'No conversation is currently available to receive this text. Open or reconnect a chat pane, then try again.'));
    }
    const radios: HTMLInputElement[] = [];
    for (const entry of active) {
      const label = el('label', 'conversation-transfer-target');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'conversation-transfer-target';
      radio.value = entry.id;
      radio.setAttribute('aria-label', entry.title);
      radio.addEventListener('click', () => {
        if (radio.checked) {
          selectedId = entry.id;
          prepared = undefined;
          try {
            prepared = entry.prepare?.({ text: boundedText, originalLength: rawText.length, truncated, title, source });
            preview.textContent = prepared?.text ?? boundedText;
            setStatus(prepared ? 'Exact final draft shown above. Existing text is included; nothing will be sent.' : 'Review the text above.');
          } catch (error) { selectedId = ''; setStatus((error as Error).message); }
        }
        syncInsert();
      });
      label.append(radio, el('span', '', entry.title));
      fieldset.append(label);
      radios.push(radio);
    }

    const actions = el('div', 'conversation-transfer-actions');
    actions.append(cancel, insert);

    function setStatus(message: string) { status.textContent = message; }
    function syncInsert() {
      insert.disabled = delivering || !selectedId || active.length === 0;
      cancel.disabled = delivering;
      for (const radio of radios) radio.disabled = delivering;
    }

    dialog.append(el('h2', '', 'Send to conversation'));
    if (title) dialog.append(el('p', 'conversation-transfer-title', title));
    if (source) dialog.append(el('p', 'conversation-transfer-source', `Source: ${source}`));
    dialog.append(
      el('p', 'conversation-transfer-notice', 'Choose a conversation below. The text is inserted into its draft only; nothing is sent or saved beyond that draft.'),
      preview,
    );
    if (truncated) {
      const bound = el('p', 'conversation-transfer-bound', `Only the first ${MAX_TRANSFER_CHARS} characters of transferred content are included; ${omitted} character${omitted === 1 ? '' : 's'} were omitted. The final draft may also include existing text.`);
      bound.setAttribute('role', 'status');
      dialog.append(bound);
    }
    dialog.append(fieldset, status, actions);

    insert.onclick = () => {
      if (delivering) return;
      if (!selectedId) { setStatus('Choose a conversation first.'); return; }
      const captured = snapshot.get(selectedId);
      const current = recipients.get(selectedId);
      if (!captured || current !== captured || !captured.available) {
        failure = { status: 'stale', recipientId: selectedId, reason: 'That conversation is no longer available.' };
        setStatus('That conversation is no longer available. The preview is unchanged; choose another conversation or cancel.');
        return;
      }
      const delivery: ConversationDelivery = {
        text: boundedText,
        originalLength: rawText.length,
        truncated,
        ...(title ? { title } : {}),
        ...(source ? { source } : {}),
      };
      const capturedPreparation = prepared;
      delivering = true;
      syncInsert();
      setStatus('Inserting into draft…');
      Promise.resolve()
        .then(async () => {
          await request.validate?.();
          // The pane can disappear or rebind between the click handler and this
          // microtask. Do not even invoke a stale recipient's callback.
          if (recipients.get(captured.id) !== captured || !captured.available)
            return { accepted: false, reason: 'That conversation is no longer available.' };
          return capturedPreparation ? capturedPreparation.commit() : captured.receive(delivery);
        })
        .then(result => {
          if (closed) return;
          if (result && (result as { accepted?: unknown }).accepted === true) {
            delivered = { status: 'delivered', recipientId: captured.id };
            failure = null;
            dialog.close();
            return;
          }
          const reason = result && typeof (result as { reason?: unknown }).reason === 'string' && (result as { reason: string }).reason
            ? (result as { reason: string }).reason
            : 'The conversation declined this text.';
          failure = { status: 'rejected', recipientId: captured.id, reason };
          setStatus(`${reason} The preview is unchanged; nothing was inserted.`);
          delivering = false;
          syncInsert();
        })
        .catch((error: unknown) => {
          if (closed) return;
          const message = error instanceof Error ? error.message : String(error);
          failure = { status: 'rejected', recipientId: captured.id, reason: `The conversation could not accept this text: ${message}` };
          setStatus(`${failure.reason} The preview is unchanged.`);
          delivering = false;
          syncInsert();
        });
    };

    // Escape cancels through the default dialog close path, but must not race an
    // in-flight async acceptance.
    dialog.addEventListener('cancel', event => { if (delivering) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      closed = true;
      if (activeDialog === dialog) activeDialog = null;
      dialog.remove();
      resolve(delivered ?? refuse());
    }, { once: true });

    document.body.append(dialog);
    activeDialog = dialog;
    syncInsert();
    dialog.showModal();
    (radios[0] ?? preview).focus();
  });
}
