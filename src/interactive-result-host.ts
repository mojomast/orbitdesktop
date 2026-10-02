import { workspaceId, ensureWorkspaceSynced } from "./workspace-sync";
import { requestConversationContext } from "./conversation-transfer";
import {
  validateResult,
  parseMessages,
  ALLOWED_COMPONENTS,
} from "./interactive-result-policy";
import { canonical } from "../contracts/interactive-results-v1.mjs";
import { extractInteractiveResult } from "./interactive-result-adapter";
import { comparisonExample } from "./interactive-result-example";
import "./interactive-result.css";

type Source = { id: string; version: string };
type Draft = {
  messages: any[];
  user_values: Record<string, any>;
  source: Source;
  title: string;
  pinned: boolean;
  id?: string;
  revision?: number;
  conflicts: Record<string, any>;
};
const drafts = new Map<string, Draft>();
const importTargets = new Map<
  string,
  { generation: string; notify: () => void; current: () => boolean }
>();
export type InteractiveDeliveryAcknowledgement = { status: 'rendered' | 'discarded' | 'stale'; deliveryId: string; workspaceId: string; paneId: string; generation: string };
type PendingResult = { id: string; messages: any[]; source: Source; generation: string; acknowledge: (status: InteractiveDeliveryAcknowledgement['status']) => void };
const pending = new Map<string, PendingResult[]>();
function invalidatePending(key: string) {
  const queue = pending.get(key) ?? [];
  pending.delete(key);
  for (const item of queue) item.acknowledge('stale');
}
export function interactiveResultTargets() {
  return [...importTargets].filter(([key]) => key.startsWith(workspaceId + ':')).map(([key, value]) => ({ paneId: key.slice(workspaceId.length + 1), generation: value.generation }));
}

/** Parent calls explicitly for an authenticated, complete tool/result text snapshot.
 * It must pass the exact source ID/version; truncated activity is not a producer.
 */
export function queueInteractiveResult(
  text: string,
  source: Source,
  options?: { paneId?: string; generation?: string; onAcknowledgement?: (ack: InteractiveDeliveryAcknowledgement) => void },
) {
  const extracted = extractInteractiveResult(text);
  if (extracted.status === "ok") {
    if (
      typeof source?.id !== "string" ||
      !source.id ||
      typeof source.version !== "string" ||
      !source.version ||
      source.id.length > 128 ||
      source.version.length > 128
    )
      return {
        status: "unavailable" as const,
        reason: "Exact source ID and version are required.",
      };
    const key = workspaceId + ':' + options?.paneId, target = importTargets.get(key);
    if (!target || !target.current() || (options?.generation && target.generation !== options.generation))
      return { status: 'unavailable' as const, reason: 'Choose a currently mounted results pane.' };
    const queue = pending.get(key) ?? [];
    if (queue.length >= 8) return { status: 'unavailable' as const, reason: 'Recipient inbox is full (8 results). Open or discard an entry first.' };
    const id = crypto.randomUUID();
    const scope = workspaceId, paneId = options!.paneId!, generation = target.generation;
    let acknowledged = false;
    queue.push({ id, messages: extracted.messages, source: { ...source }, generation, acknowledge: status => {
      if (acknowledged) return; acknowledged = true;
      try { options?.onAcknowledgement?.({ status, deliveryId: id, workspaceId: scope, paneId, generation }); } catch { /* Acknowledgement UI cannot change delivery outcome. */ }
    } });
    pending.set(key, queue); target.notify();
    return { status: 'queued' as const, deliveryId: id, paneId: options!.paneId!, generation: target.generation };
  }
  return extracted;
}

export function mountInteractiveResults(
  host: HTMLElement,
  token: () => string,
  options?: {
    paneId?: string;
    initialResult?: { text: string; source: Source };
  },
): { dispose(): void } {
  const key = workspaceId + ":" + (options?.paneId ?? "library");
  let draft: Draft | undefined = drafts.get(key),
    disposed = false,
    generation = 0,
    applying = false;
  let processor: any,
    baseline: any,
    element: any,
    subscriptions: any[] = [],
    summaryDialog: HTMLDialogElement | undefined;
  let renderer: Promise<any> | undefined;
  const abort = new AbortController();
  let bindingController = new AbortController(),
    bindingEpoch = 0,
    libraryEpoch = 0;
  let boundToken = "",
    boundWorkspace = workspaceId,
    loadingEpoch: number | undefined;
  let nextRefresh = 0,
    connectionIssue = false;
  function liveBinding() {
    let credential = "",
      scope = workspaceId;
    try {
      credential = token();
    } catch {
      /* Locked host. */
    }
    try {
      scope = localStorage.getItem("orbit.workspace.id") || workspaceId;
    } catch {}
    return { credential, scope };
  }
  function syncBinding(force = false) {
    const { credential, scope } = liveBinding();
    if (force || credential !== boundToken || scope !== boundWorkspace) {
      bindingController.abort();
      bindingController = new AbortController();
      ++bindingEpoch;
      ++libraryEpoch;
      nextRefresh = 0;
      boundToken = credential;
      boundWorkspace = scope;
      if (importTargets.get(key) === acceptImport) {
        invalidatePending(key);
        acceptImport.generation = crypto.randomUUID();
        acceptImport.notify();
      }
      summaryDialog?.close();
      library.replaceChildren();
    }
  }
  const root = document.createElement("section");
  root.className = "interactive-results";
  const heading = document.createElement("h2");
  heading.textContent = "Interactive results";
  root.append(heading);
  const help = document.createElement("p");
  help.textContent =
    "Import an explicit A2UI v0.9 JSON result, edit its fields, then save or prepare a draft summary.";
  root.append(help);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  root.append(status);
  const library = document.createElement("div");
  library.className = "interactive-result-library";
  root.append(library);
  const title = document.createElement("input");
  title.placeholder = "Result title";
  title.maxLength = 60;
  title.setAttribute("aria-label", "Result title");
  root.append(title);
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "A2UI JSON import or incremental messages");
  input.placeholder = "Paste JSON, a JSON message array, or NDJSON";
  root.append(input);
  const tools = document.createElement("div");
  tools.className = "interactive-result-toolbar";
  root.append(tools);
  const conflicts = document.createElement("div");
  conflicts.setAttribute("role", "alert");
  root.append(conflicts);
  const canvas = document.createElement("div");
  canvas.className = "interactive-result-canvas";
  root.append(canvas);
  const labelControls = () => {
    // 0.12.0 TextField renders a visible label without an input association.
    const container: ShadowRoot | undefined = element?.shadowRoot;
    for (const control of Array.from(
      container?.querySelectorAll<HTMLInputElement>(
        "a2ui-basic-textfield input, a2ui-basic-textfield textarea",
      ) ?? [],
    )) {
      const label = control
        .closest("a2ui-basic-textfield")
        ?.querySelector("label")?.textContent;
      if (label && control.getAttribute("aria-label") !== label)
        control.setAttribute("aria-label", label);
    }
  };
  const labels = new MutationObserver(labelControls);
  // The renderer consumes Lit contexts. Untrusted results cannot inherit plugins
  // supplied by an ancestor in this trusted host realm.
  root.addEventListener("context-request", (event) => event.stopPropagation(), {
    signal: abort.signal,
  });
  host.append(root);
  const say = (text: string) => {
    if (!disposed) status.textContent = text;
  };
  const report = (error: any) => {
    if (
      disposed ||
      error.name === "AbortError" ||
      error.code === "stale_binding"
    )
      return;
    say((error.code ? error.code + ": " : "") + error.message);
  };
  function button(label: string, action: () => any) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener(
      "click",
      () => Promise.resolve().then(action).catch(report),
      { signal: abort.signal },
    );
    tools.append(b);
    return b;
  }
  async function api(body: any) {
    syncBinding();
    if (boundWorkspace !== workspaceId)
      throw Error(
        "Workspace binding changed; reopen this workspace before using its saved library.",
      );
    if (!boundToken) throw Error("Connect host to enable workspace control.");
    const own = bindingEpoch,
      credential = boundToken;
    const signal = AbortSignal.any([
      abort.signal,
      bindingController.signal,
      AbortSignal.timeout(15000),
    ]);
    function current() {
      const live = liveBinding();
      if (
        disposed ||
        own !== bindingEpoch ||
        live.credential !== credential ||
        live.scope !== workspaceId ||
        signal.aborted
      ) {
        syncBinding();
        throw Object.assign(Error("Host binding changed during request."), {
          code: "stale_binding",
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      const interrupted = () => reject(signal.reason);
      signal.addEventListener("abort", interrupted, { once: true });
      if (signal.aborted) {
        interrupted();
        return;
      }
      ensureWorkspaceSynced()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", interrupted));
    });
    current();
    const response = await fetch("/api/interactive-results", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + credential,
      },
      body: JSON.stringify({ ...body, workspace_id: workspaceId }),
      signal,
    });
    const result = await response.json();
    current();
    if (!response.ok || result.ok === false)
      throw Object.assign(
        Error(result.error || result.code || "Result request failed"),
        { code: result.code },
      );
    return result;
  }
  function retain() {
    if (draft) {
      draft.title = title.value || draft.title;
      drafts.set(key, structuredClone(draft));
    }
  }
  function cleanupRenderer() {
    labels.disconnect();
    subscriptions.forEach((s) => s.unsubscribe());
    subscriptions = [];
    processor?.dispose();
    baseline?.dispose();
    processor = baseline = undefined;
    element?.remove();
    element = undefined;
  }
  function rendererMessages(messages: any[]) {
    const copy = structuredClone(messages);
    // 0.12.0 basic Text has a GLOBAL markdown fallback as well as context injection.
    // Use its official escaped-text variant, preventing unsafeHTML even if another
    // trusted surface installs a markdown plugin. Never install/reset global state.
    for (const message of copy)
      for (const component of message.updateComponents?.components ?? []) {
        if (
          component.component === "Text" &&
          !["h1", "h2", "h3", "h4", "h5", "caption"].includes(component.variant)
        )
          component.variant = "caption";
      }
    return copy;
  }
  function conflictUI() {
    conflicts.replaceChildren();
    if (!draft) return;
    for (const path of Object.keys(draft.conflicts)) {
      const row = document.createElement("div");
      row.textContent =
        "Incoming update conflicts with your edit: " + path + " ";
      const accept = document.createElement("button");
      accept.textContent = "Use incoming value";
      accept.type = "button";
      accept.addEventListener(
        "click",
        () => {
          if (!draft) return;
          applying = true;
          processor
            .getSurface(validateResult(draft.messages).surfaceId)
            .dataModel.set(
              path,
              baseline
                .getSurface(validateResult(draft.messages).surfaceId)
                .dataModel.get(path),
            );
          delete draft.user_values[path];
          delete draft.conflicts[path];
          applying = false;
          retain();
          conflictUI();
        },
        { signal: abort.signal },
      );
      row.append(accept);
      conflicts.append(row);
    }
  }
  function subscribe() {
    subscriptions.forEach((s) => s.unsubscribe());
    subscriptions = [];
    if (!draft) return;
    const { surfaceId, bindings } = validateResult(
        draft.messages,
        draft.user_values,
      ),
      surface = processor.getSurface(surfaceId);
    for (const path of bindings)
      subscriptions.push(
        surface.dataModel.subscribe(path, (value: any) => {
          if (applying || disposed || !draft) return;
          // Renderer writes are recorded separately from producer data, not appended to its stream.
          if (value !== undefined) {
            draft.user_values[path] = structuredClone(value);
            retain();
          }
        }),
      );
  }
  async function render() {
    if (!draft) return;
    const own = ++generation;
    renderer ??= Promise.all([
      import("@a2ui/lit/v0_9"),
      import("@a2ui/web_core/v0_9"),
    ]);
    const [lit, core] = await renderer;
    if (disposed || own !== generation) return;
    validateResult(draft.messages, draft.user_values);
    cleanupRenderer();
    applying = true;
    // Real official implementations, restricted to reviewed components and no local functions.
    const catalog = new core.Catalog(
      lit.basicCatalog.id,
      "0.9",
      [...lit.basicCatalog.components.values()].filter((c) =>
        ALLOWED_COMPONENTS.includes(c.name),
      ),
      [],
    );
    processor = new core.MessageProcessor([catalog], (action: any) => {
      if (!disposed && action.name === "prepare_summary")
        void summary().catch(report);
    });
    baseline = new core.MessageProcessor([catalog]);
    try {
      // The official DataModel adopts object references. Never let renderer writes
      // mutate the immutable producer stream or the independent incoming baseline.
      baseline.processMessages(rendererMessages(draft.messages));
      processor.processMessages(rendererMessages(draft.messages));
      const { surfaceId } = validateResult(draft.messages, draft.user_values),
        surface = processor.getSurface(surfaceId);
      for (const [path, value] of Object.entries(draft.user_values))
        surface.dataModel.set(path, value);
      element = document.createElement("a2ui-surface");
      element.surface = surface;
      canvas.append(element);
      await element.updateComplete;
      if (disposed || own !== generation) return;
      if (element.shadowRoot) {
        const style = document.createElement("style");
        style.textContent =
          ".a2ui-text.caption{font-size:inherit}.a2ui-text.caption em{font-style:normal}";
        element.shadowRoot.append(style);
        labels.observe(element.shadowRoot, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
      labelControls();
      subscribe();
      conflictUI();
      pin.textContent = draft.pinned ? "Unpin result" : "Pin result";
      say(
        "Rendered with official A2UI v0.9. User fields are saved separately.",
      );
    } catch (error) {
      cleanupRenderer();
      throw error;
    } finally {
      applying = false;
    }
  }
  async function replace(messages: any[], source: Source) {
    validateResult(messages);
    draft = {
      messages: structuredClone(messages),
      user_values: {},
      source,
      title: title.value || "Interactive result",
      pinned: false,
      conflicts: {},
    };
    retain();
    await render();
  }
  async function append() {
    if (!draft || !processor)
      throw Error("Import a result before applying updates.");
    // Incremental batches are validated against the full original stream before processing.
    let incoming: any;
    try {
      incoming = JSON.parse(input.value);
    } catch {
      incoming = input.value
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
    }
    const batch = Array.isArray(incoming) ? incoming : [incoming],
      all = [...draft.messages, ...batch];
    const validation = validateResult(all, draft.user_values),
      old = validateResult(draft.messages, draft.user_values);
    for (const path of Object.keys(draft.user_values)) {
      const before = [...old.components.values()]
        .filter((c) => c.value?.path === path)
        .map((c) => c.id)
        .sort();
      const after = [...validation.components.values()]
        .filter((c) => c.value?.path === path)
        .map((c) => c.id)
        .sort();
      if (canonical(before) !== canonical(after))
        throw Error(
          "An update changed an edited field binding. Import this source as a new result.",
        );
    }
    applying = true;
    try {
      const surface = baseline.getSurface(validation.surfaceId),
        before = new Map(
          Object.keys(draft.user_values).map((path) => [
            path,
            canonical(surface.dataModel.get(path)),
          ]),
        );
      baseline.processMessages(rendererMessages(batch));
      processor.processMessages(rendererMessages(batch));
      for (const [path, value] of Object.entries(draft.user_values)) {
        const incomingValue = surface.dataModel.get(path);
        if (
          canonical(incomingValue) !== before.get(path) &&
          canonical(incomingValue) !== canonical(value)
        )
          draft.conflicts[path] = incomingValue ?? null;
        processor.getSurface(validation.surfaceId).dataModel.set(path, value);
      }
      draft.messages = all;
      subscribe();
      retain();
      conflictUI();
      say("Incremental update applied; your edits were preserved.");
    } catch (error) {
      await render();
      throw error;
    } finally {
      applying = false;
    }
  }
  async function refresh() {
    syncBinding();
    const own = ++libraryEpoch;
    const { items } = await api({ action: "list" });
    if (disposed || own !== libraryEpoch) return;
    library.replaceChildren();
    for (const item of items) {
      const b = document.createElement("button");
      b.textContent = (item.pinned ? "★ " : "") + item.title;
      b.type = "button";
      b.addEventListener(
        "click",
        async () => {
          const own = ++generation;
          try {
            const { record } = await api({ action: "read", id: item.id });
            if (disposed || own !== generation) return;
            draft = { ...record, conflicts: {} };
            title.value = draft!.title;
            retain();
            await render();
          } catch (error) {
            report(error);
          }
        },
        { signal: abort.signal },
      );
      library.append(b);
    }
  }
  async function reconnect(force = false) {
    if (disposed) return;
    syncBinding(force);
    if (!boundToken || boundWorkspace !== workspaceId) {
      nextRefresh = Infinity;
      connectionIssue = true;
      say(
        boundWorkspace !== workspaceId
          ? "Workspace binding changed; reopen this workspace before using its saved library."
          : "Connect host to enable workspace control.",
      );
      return;
    }
    const own = bindingEpoch;
    if (loadingEpoch === own) return;
    loadingEpoch = own;
    nextRefresh = Infinity;
    try {
      await refresh();
      if (disposed || own !== bindingEpoch) return;
      if (connectionIssue)
        say("Saved result library connected. Your local edits were preserved.");
      connectionIssue = false;
      nextRefresh = Date.now() + 15000;
    } catch (error) {
      if (disposed || own !== bindingEpoch) return;
      connectionIssue = true;
      nextRefresh = Date.now() + 3000;
      report(error);
    } finally {
      if (loadingEpoch === own) loadingEpoch = undefined;
    }
  }
  let saveRequest: any;
  async function save() {
    if (!draft) throw Error("Import a result first.");
    retain();
    validateResult(draft.messages, draft.user_values);
    const payload = {
      action: draft.id ? "update" : "create",
      ...(draft.id ? { id: draft.id, expected_revision: draft.revision } : {}),
      title: draft.title,
      messages: structuredClone(draft.messages),
      user_values: structuredClone(draft.user_values),
      source: draft.source,
      pinned: draft.pinned,
    };
    // Preserve exact retry identity after uncertain responses. New edits get a new operation.
    if (!saveRequest || canonical(saveRequest.payload) !== canonical(payload))
      saveRequest = { payload, op_id: crypto.randomUUID() };
    const snapshot = draft,
      own = generation;
    const { record } = await api({
      ...saveRequest.payload,
      op_id: saveRequest.op_id,
    });
    if (disposed || own !== generation || draft !== snapshot) return;
    draft.id = record.id;
    draft.revision = record.revision;
    saveRequest = undefined;
    retain();
    say("Saved private result revision " + record.revision + ".");
    await refresh();
  }
  async function summary() {
    if (!draft || !processor) throw Error("Import a result first.");
    const transferBinding = liveBinding();
    const captured = structuredClone(draft),
      own = generation;
    if (captured.id) {
      const { record } = await api({ action: "read", id: captured.id });
      if (
        record.revision !== captured.revision ||
        canonical(record.source) !== canonical(captured.source) ||
        canonical(record.messages) !== canonical(captured.messages)
      )
        throw Error(
          "Saved source/stream changed. Save or reopen before preparing a summary.",
        );
    }
    if (
      disposed ||
      own !== generation ||
      canonical(captured) !== canonical(draft)
    )
      throw Error("Result changed while preparing its summary.");
    const texts = [
      ...validateResult(
        captured.messages,
        captured.user_values,
      ).components.values(),
    ]
      .filter((c) => c.component === "Text")
      .map((c) =>
        typeof c.text === "string"
          ? c.text
          : c.text
            ? processor
                .getSurface(validateResult(captured.messages).surfaceId)
                .dataModel.get(c.text.path)
            : undefined,
      )
      .filter((v) => typeof v === "string");
    const fields = [
      ...validateResult(captured.messages, captured.user_values).bindings,
    ].map(
      (path) =>
        path +
        ": " +
        JSON.stringify(
          processor
            .getSurface(validateResult(captured.messages).surfaceId)
            .dataModel.get(path),
        ),
    );
    const text = [
      captured.title,
      "Source: " + captured.source.id + " @ " + captured.source.version,
      ...texts,
      ...fields,
    ].join("\n");
    if (text.length > 20000)
      throw Error(
        "Summary exceeds 20,000 characters; shorten result text first.",
      );
    const existing = document.querySelector("dialog.conversation-transfer");
    const transfer = requestConversationContext({
      text,
      title: captured.title,
      source: "Interactive result (explicit owner preview)",
      validate: async () => {
        const live = liveBinding();
        if (live.credential !== transferBinding.credential || live.scope !== transferBinding.scope || live.scope !== workspaceId) throw Error('Result host binding changed.');
        if (disposed || own !== generation || canonical(captured) !== canonical(draft)) throw Error('Result changed since preview.');
        if (captured.id) {
          const { record } = await api({ action: 'read', id: captured.id });
          if (record.revision !== captured.revision || canonical(record.source) !== canonical(captured.source) || canonical(record.messages) !== canonical(captured.messages)) throw Error('Saved result changed since preview.');
        }
        if (disposed || own !== generation || canonical(captured) !== canonical(draft)) throw Error('Result changed since preview.');
      },
    });
    const dialog = document.querySelector<HTMLDialogElement>(
      "dialog.conversation-transfer",
    );
    if (dialog && dialog !== existing) {
      summaryDialog = dialog;
    }
    await transfer;
    if (summaryDialog === dialog) summaryDialog = undefined;
  }
  button("Import JSON", () =>
    replace(parseMessages(input.value), {
      id: "import-" + crypto.randomUUID(),
      version: "1",
    }),
  );
  button("Apply incremental updates", append);
  button("Load editable comparison", () => {
    title.value = "Editable comparison";
    return replace(comparisonExample, {
      id: "example-" + crypto.randomUUID(),
      version: "1",
    });
  });
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".json,.jsonl,application/json";
  file.setAttribute("aria-label", "Import JSON file");
  tools.append(file);
  file.addEventListener(
    "change",
    async () => {
      try {
        const selected = file.files?.[0];
        if (!selected) return;
        if (selected.size > 262144) throw Error("File exceeds 256 KiB");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          await selected.arrayBuffer(),
        );
        if (!disposed)
          await replace(parseMessages(text), {
            id: "import-" + crypto.randomUUID(),
            version: "1",
          });
      } catch (error) {
        report(error);
      }
    },
    { signal: abort.signal },
  );
  button("Save result", save);
  const pin = button("Pin result", () => {
    if (!draft) throw Error("Import a result first.");
    draft.pinned = !draft.pinned;
    pin.textContent = draft.pinned ? "Unpin result" : "Pin result";
    retain();
    return save();
  });
  button("Prepare summary", summary);
  button("Export JSON", () => {
    if (!draft) throw Error("Import a result first.");
    const blob = new Blob([JSON.stringify({ a2ui: draft.messages }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "interactive-result.json";
    a.click();
    URL.revokeObjectURL(url);
    say("Exported producer stream. Private edits remain in the saved library.");
  });
  title.addEventListener("input", retain, { signal: abort.signal });
  root.addEventListener("dragover", (event) => event.preventDefault(), {
    signal: abort.signal,
  });
  root.addEventListener(
    "drop",
    async (event) => {
      event.preventDefault();
      try {
        const f = event.dataTransfer?.files[0];
        if (!f || f.size > 262144)
          throw Error("Drop a JSON file up to 256 KiB.");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          await f.arrayBuffer(),
        );
        if (!disposed)
          await replace(parseMessages(text), {
            id: "import-" + crypto.randomUUID(),
            version: "1",
          });
      } catch (error) {
        report(error);
      }
    },
    { signal: abort.signal },
  );
  if (draft) {
    title.value = draft.title;
    void render().catch(report);
  }
  const targetId = key;
  const inbox = document.createElement('div'); inbox.setAttribute('aria-label', 'Incoming interactive results'); root.prepend(inbox);
  const acceptImport = { generation: crypto.randomUUID(), current: (): boolean => {
    const live = liveBinding();
    return importTargets.get(key) === acceptImport && !disposed && !!boundToken && live.credential === boundToken && live.scope === boundWorkspace && boundWorkspace === workspaceId;
  }, notify: () => {
    inbox.replaceChildren();
    for (const incoming of pending.get(key) ?? []) {
      const row = document.createElement('div'); row.textContent = `Queued ${incoming.source.id} @ ${incoming.source.version} · ${incoming.id} `;
      for (const label of ['Open queued result', 'Discard queued result']) {
        const b = document.createElement('button'); b.textContent = label;
        b.onclick = () => { void (async () => {
          syncBinding();
          if (!acceptImport.current() || incoming.generation !== acceptImport.generation) throw Error('Recipient binding changed.');
          if (label === 'Open queued result') {
            if (draft && !confirm('Replace the displayed result? Save your current edits first to retain them in the private library.')) return;
            const rendering = replace(incoming.messages, incoming.source), capturedDraft = draft;
            await rendering;
            if (!acceptImport.current() || incoming.generation !== acceptImport.generation || draft !== capturedDraft) throw Error('Delivery render was superseded; no render acknowledgement.');
            say(`Rendered delivery ${incoming.id} in pane ${options?.paneId ?? 'library'}. Save remains explicit.`);
          }
          pending.set(key, (pending.get(key) ?? []).filter(item => item !== incoming)); acceptImport.notify();
          incoming.acknowledge(label === 'Open queued result' ? 'rendered' : 'discarded');
        })().catch(report); };
        row.append(b);
      }
      inbox.append(row);
    }
  }};
  importTargets.set(targetId, acceptImport);
  syncBinding();
  if (options?.initialResult) queueInteractiveResult(options.initialResult.text, options.initialResult.source, { paneId: options?.paneId ?? 'library', generation: acceptImport.generation });
  window.addEventListener(
    "orbit-host-connected",
    () => {
      void reconnect(true);
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    "storage",
    (event) => {
      if (event.key === "orbit.workspace.id") void reconnect(true);
    },
    { signal: abort.signal },
  );
  const reconnectTimer = window.setInterval(() => {
    if (disposed) return;
    const live = liveBinding();
    if (
      live.credential !== boundToken ||
      live.scope !== boundWorkspace ||
      Date.now() >= nextRefresh
    )
      void reconnect();
  }, 1000);
  void reconnect();
  return {
    dispose() {
      if (disposed) return;
      retain();
      disposed = true;
      if (importTargets.get(targetId) === acceptImport) {
        importTargets.delete(targetId);
        invalidatePending(key);
      }
      ++generation;
      summaryDialog?.close();
      clearInterval(reconnectTimer);
      bindingController.abort();
      abort.abort();
      labels.disconnect();
      cleanupRenderer();
      root.remove();
    },
  };
}
