# Selected-context transfer

This document is the interface contract for transferring an explicit piece of
selected text from a trusted workspace surface into exactly one trusted chat
conversation draft. It is implemented by the new module
`src/conversation-transfer.ts` (styles in `src/conversation-transfer.css`). The
module is application code in the parent page, not a generated-plugin API.

The transfer is deliberately narrow:

- One caller supplies the exact text. The module never reads a selection, a
  terminal buffer, an iframe document or a source URL itself.
- The host dialog bounds the preview to `MAX_TRANSFER_CHARS` (20000) and reports
  the omitted count instead of silently truncating.
- The user explicitly chooses one registered, currently available recipient.
- Only the chosen recipient's `receive` callback is invoked. There is no
  broadcast, no `postMessage`, no custom event carrying the text and no global
  registry fan-out.
- Delivery is an async acceptance. The recipient validates its own exact
  conversation binding and may reject. A rejection or a stale recipient leaves
  the dialog and preview open with the text intact.
- Nothing is sent to a model, no grant is created, no URL is fetched and no
  binding is switched by the transfer.

## Public API

```ts
export const MAX_TRANSFER_CHARS = 20000;

export interface ConversationTransferRequest {
  /** Exact text to transfer; required. Empty/whitespace-only text is refused. */
  text: string;
  /** Optional short label shown above the preview. Not part of the text. */
  title?: string;
  /** Optional provenance label such as "workspace selection". Never dereferenced. */
  source?: string;
}

/** Payload handed to exactly one chosen recipient's `receive`. */
export interface ConversationDelivery {
  /** Bounded text, length <= MAX_TRANSFER_CHARS. */
  text: string;
  /** Full requested length before bounding. */
  originalLength: number;
  /** True when originalLength > MAX_TRANSFER_CHARS. */
  truncated: boolean;
  title?: string;
  source?: string;
}

/** Async acceptance. `accepted: false` must mean nothing changed. */
export type ConversationDeliveryResult =
  | { accepted: true }
  | { accepted: false; reason?: string };

export interface ConversationRecipientOptions {
  /** Stable recipient id, 1–128 chars. Re-registering replaces the entry. */
  id: string;
  /** Human label shown in the target list. */
  title: string;
  /** Current eligibility. Defaults to true. Change via the update handle. */
  available?: boolean;
  /**
   * Validates the recipient's exact capture binding against its live
   * conversation, then inserts into that draft. May be async. Must not mutate
   * the conversation when it returns `accepted: false`.
   */
  receive: (
    delivery: ConversationDelivery,
  ) => ConversationDeliveryResult | Promise<ConversationDeliveryResult>;
}

export interface ConversationRecipientHandle {
  readonly id: string;
  update(patch: { title?: string; available?: boolean }): void;
  /** Idempotent. After dispose the recipient is never delivered to again. */
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

export function registerConversationRecipient(
  options: ConversationRecipientOptions,
): ConversationRecipientHandle;

export function listConversationRecipients(): ConversationRecipientSummary[];

export function requestConversationContext(
  request: ConversationTransferRequest,
): Promise<ConversationTransferOutcome>;
```

### Delivery semantics

- `requestConversationContext` refuses empty/whitespace text with
  `{ status: 'empty' }` and opens no dialog. A second request while a transfer
  dialog is open focuses the existing dialog and resolves `{ status: 'busy' }`.
- The dialog snapshots the registered recipients at open time. It lists only
  entries whose `available` is `true`; disposed entries are absent because they
  are removed from the registry.
- If no recipient is eligible, the dialog still opens for feedback (an empty
  target list and a disabled **Insert into draft**). Closing or cancelling that
  dialog resolves `{ status: 'no-recipient' }` rather than `cancelled`.
- **Insert into draft** is enabled only after the user picks a target.
- On insert the module re-checks the registry: the selected entry must still be
  the same entry object and still `available`. If not, it records a `stale`
  failure, reports the target as no longer available, and leaves the preview
  open.
- Otherwise it awaits `receive(delivery)`. `{ accepted: true }` closes the
  dialog and resolves `{ status: 'delivered', recipientId }`. `{ accepted:
  false }` or a thrown/rejected promise records a `rejected` failure and keeps
  the dialog and preview open with the reason.
- The outcome is decided when the dialog actually closes: a successful delivery
  wins; otherwise the last insert failure (`rejected`/`stale`, with its reason)
  is reported if there was one; otherwise `cancelled`. With no eligible
  recipient it is `no-recipient`. Escape and Cancel are ignored while an async
  acceptance is in flight so a late insert cannot race a closed dialog.
- The outcome union is informational; the caller does not need to inspect it to
  use the dialog.

## Recipient registry rules

- `receive` is the authority on the live binding. It must capture the exact
  binding at registration/update time (profile id, session id, binding revision,
  pane identity) and re-validate it before inserting. If the pane was disposed,
  rebound or switched, return `{ accepted: false, reason }`.
- The registry additionally guarantees: after `dispose()` the recipient is not
  called; replacing a recipient id with a new registration invalidates the old
  snapshot; an `available: false` update removes it from the dialog list and
  blocks an in-flight selection to it.
- Only the single user-chosen recipient's `receive` runs. The registry never
  delivers to every pane.

## Chat pane integration (owned by the agent-chat work)

On mount, register once and dispose in the pane cleanup:

```ts
import { registerConversationRecipient } from './conversation-transfer';
import { chatBindingKey } from './chat-storage';

const captured = { key: chatBindingKey(state), paneId };
const recipient = registerConversationRecipient({
  id: `chat:${paneId}`,
  title: state.title || 'Hermes conversation',
  available: bindingReady,
  async receive({ text }) {
    if (disposed || chatBindingKey(state) !== captured.key || state.run) {
      return { accepted: false, reason: 'This conversation changed; the text was not inserted.' };
    }
    // Explicit draft insertion only. Never call submit() from here.
    input.value = input.value ? `${input.value}\n${text}` : text;
    saveDraft();
    return { accepted: true };
  },
});
// On binding change: recipient.update({ available: bindingReady, title: ... });
// In the returned cleanup: recipient.dispose();
```

The pane must update `available` when it loses or regains its host binding, and
must not call `submit`/`start` from `receive`.

## Parent shell command (owned by the command/selection work)

The shell caches the parent document's own selection through a
`selectionchange` listener (refusing selections inside dialogs, inputs, editors
and terminals, and cleared on `pagehide`); the command sends that captured text.
It never reads an iframe/sandbox document, plugin frame, terminal buffer or
clipboard:

```ts
{
  id: 'send-selection',
  title: 'Send selected text to conversation',
  detail: 'Review recently selected workspace text and choose a draft; never sends automatically',
  group: 'Hermes',
  run: () => {
    const text = selectedWorkspaceText; // captured by the parent selectionchange handler
    if (!text) { report('Select up to 20,000 characters of workspace text first.'); return; }
    void requestConversationContext({ text, title: 'Selected workspace text' });
  },
}
```

## Explicit non-goals

- No auto-send / model request, no auto-created grants, no URL fetch, no
  switching the recipient's binding.
- No public plugin `postMessage` or host-bridge API; generated frames never see
  this module or its text.
- No global event carrying content, and no persistence: the text lives only in
  memory for the dialog and, on acceptance, in the chosen conversation draft.
- No unbounded copy: the preview and delivery are capped at `MAX_TRANSFER_CHARS`
  with a visible omitted-character notice.

## Verification

`tests/conversation-transfer.browser.py` is a standalone real-browser fixture
(no owner runtime, terminals or providers) that imports the module directly and
verifies: the selected target receives once; cancel delivers nothing; a stale /
disconnected recipient fails with the preview retained; disconnected recipients
are omitted; the HTML preview is inert; no network request or model send occurs;
and the max-bound notice is shown instead of silent truncation.
