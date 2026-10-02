import { el, select } from "./dom";
import {
  createSearchClient,
  SearchError,
  type SearchStatus,
  type SearchSource,
  type SearchResult,
  type SourceSnapshot,
} from "./search-client";
import { requestConversationContext } from "./conversation-transfer";
import { sourceSelectionOffsets, formatKnowledgeExcerpt } from './search-evidence';
import { workspaceId } from './workspace-sync';
import "./search-surface.css";
import { mountResourceGrants } from './resource-grants';

export function mountSearchSurface(
  host: HTMLElement,
  token: () => string,
  _options?: { paneId?: string },
): { dispose(): void } {
  const controller = new AbortController(),
    request = createSearchClient(token, controller.signal);
  let disposed = false,
    busy = false,
    generation = 0,
    queryVersion = 0;
  const root = el("section", "knowledge-search");
  const grantsHost=el('div');
  const grants=mountResourceGrants(grantsHost,token);
  root.setAttribute("aria-label", "Local source search");
  const status = el("p", "knowledge-status", "Connecting…");
  status.setAttribute("role", "status");
  const notice = el(
    "p",
    "knowledge-notice",
    "Only text and files you explicitly add are indexed. Snapshots stay private to this workspace. Semantic inference is local; no model request is sent.",
  );
  const error = el("p", "knowledge-error");
  error.setAttribute("role", "alert");
  function action(label: string, fn: () => void) {
    const b = el("button", "", label);
    b.type = "button";
    b.onclick = fn;
    return b;
  }
  function field(label: string, node: HTMLElement) {
    const l = el("label", "knowledge-field");
    l.append(el("span", "", label), node);
    return l;
  }
  function message(e: unknown) {
    if (disposed) return false;
    let adoptedGeneration = false;
    if (e instanceof SearchError && e.code === "conflict") {
      const current = e.current;
      if (current && typeof current === "object" && !Array.isArray(current)) {
        const reported = (current as { consent_generation?: unknown })
          .consent_generation;
        if (
          typeof reported === "number" &&
          Number.isSafeInteger(reported) &&
          reported >= 0
        ) {
          generation = reported;
          adoptedGeneration = true;
        }
      }
    }
    error.textContent =
      e instanceof SearchError && e.code === "conflict"
        ? `Conflict: ${e.message}. ${adoptedGeneration ? "Current generation adopted; refreshing sources. Review before retrying" : "Refresh and review before retrying"}; your edits are retained.`
        : e instanceof Error
          ? e.message
          : String(e);
    return adoptedGeneration;
  }
  async function run(fn: () => Promise<void>) {
    if (busy || disposed) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    error.textContent = "";
    try {
      await fn();
    } catch (e) {
      if (message(e)) {
        invalidate();
        try {
          await refresh();
          if (!disposed)
            error.textContent = `Conflict: ${(e as SearchError).message}. Sources refreshed; review before retrying. Your edits are retained.`;
        } catch {
          if (!disposed)
            error.textContent +=
              " Source refresh failed; the reported generation and your edits are retained. Try Refresh status and sources.";
        }
      }
    } finally {
      busy = false;
      root.removeAttribute("aria-busy");
    }
  }
  const title = el("input");
  title.maxLength = 200;
  title.placeholder = "Short source title";
  title.setAttribute("aria-label", "Source title");
  const location = el("input");
  location.maxLength = 200;
  location.placeholder = "Optional owner-supplied source label";
  const kind = select(
    [
      ["owner_text", "Owner text"],
      ["selected_text", "Pasted selection"],
      ["conversation_excerpt", "Explicit conversation excerpt"],
    ],
    "owner_text",
    () => {},
  );
  const text = el("textarea");
  text.rows = 6;
  text.maxLength = 100000;
  text.setAttribute("aria-label", "Source text");
  const file = el("input");
  file.type = "file";
  file.accept =
    ".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json";
  file.setAttribute("aria-label", "Choose source file");
  const sourceList = el("div", "knowledge-sources");
  const resultList = el("div", "knowledge-results");
  resultList.setAttribute("aria-label", "Search results");
  const snapshotHost = el("div", "knowledge-snapshot");
  const query = el("input");
  query.type = "search";
  query.maxLength = 500;
  query.setAttribute("aria-label", "Search query");
  query.placeholder = "Search your added sources";
  const mode = select(
    [
      ["hybrid", "Hybrid (semantic when available)"],
      ["keyword", "Keyword only"],
    ],
    "hybrid",
    () => {},
  );
  mode.setAttribute("aria-label", "Search mode");
  const filter = select(
    [
      ["", "All source kinds"],
      ["owner_text", "Owner text"],
      ["selected_text", "Pasted selection"],
      ["conversation_excerpt", "Conversation excerpts"],
      ["file", "Files"],
    ],
    "",
    () => {},
  );
  filter.setAttribute("aria-label", "Source kind filter");
  function invalidate() {
    queryVersion++;
    resultList.replaceChildren();
    snapshotHost.replaceChildren();
  }
  async function refresh() {
    const [info, list] = await Promise.all([
      request<SearchStatus>("status"),
      request<{ sources: SearchSource[]; consent_generation: number }>(
        "list_sources",
      ),
    ]);
    if (disposed) return;
    generation = list.consent_generation;
    grants.updateSources(list.sources);
    status.textContent = `${info.source_count} sources · ${info.semantic_chunk_count}/${info.chunk_count} passages embedded · Semantic ${info.semantic.present && info.semantic.vector_available && !info.semantic.error ? "on (local MiniLM)" : "off"}${info.indexing ? " · Indexing…" : ""}. ${info.semantic.note}`;
    sourceList.replaceChildren();
    for (const s of list.sources) {
      const item = el("div", "knowledge-source");
      item.append(
        el("strong", "", s.title),
        el(
          "small",
          "",
          `${s.kind} · ${s.status} · ${s.content_sha256.slice(0, 12)}`,
        ),
      );
      item.append(
        action(
          "Open exact snapshot",
          () => void run(() => openSnapshot(s.source_id)),
        ),
        action(
          "Remove source",
          () =>
            void run(async () => {
              if (
                !confirm(
                  `Remove “${s.title}” from this workspace’s ingested snapshots and index? This is logical deletion, not guaranteed physical erasure.`,
                )
              )
                return;
              await request("delete_source", {
                source_id: s.source_id,
                base_consent_generation: generation,
              });
              invalidate();
              await refresh();
            }),
        ),
      );
      sourceList.append(item);
    }
    if (!list.sources.length)
      sourceList.append(el("p", "", "No sources added yet."));
  }
  async function openSnapshot(source_id: string) {
    const s = await request<SourceSnapshot>("get_source", { source_id });
    if (disposed) return;
    snapshotHost.replaceChildren();
    const pre = el("pre", "", s.text);
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", "Exact source snapshot");
    const download = action("Download original bytes", () => {
      const bytes = Uint8Array.from(atob(s.data_base64), (c) =>
        c.charCodeAt(0),
      );
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/octet-stream" }),
      );
      const link = el("a");
      link.href = url;
      link.download = "source-snapshot.txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    snapshotHost.append(
      el("h3", "", s.title),
      el(
        "small",
        "",
        `Exact ingested snapshot · SHA256 ${s.content_sha256} · ${s.extractor_version}. This does not open a changed upstream file.`,
      ),
      download,
      action("Close snapshot", () => snapshotHost.replaceChildren()),
      pre,
    );
  }
  function renderResult(r: SearchResult) {
    const item = el("article", "knowledge-result");
    const citation = `${r.source_id} · ${r.extractor_version} · UTF-16 [${r.char_start}, ${r.char_end}) · text SHA256 ${r.text_sha256}`;
    const passage = el("textarea", "knowledge-passage");
    passage.value = r.snippet;
    passage.readOnly = true;
    passage.rows = 5;
    passage.setAttribute("aria-label", `Passage from ${r.title}`);
    item.append(
      el("h3", "", r.title),
      el("small", "", `${r.source_kind} · ${r.matched} · ${r.location}`),
      passage,
      el("small", "knowledge-citation", citation),
    );
    item.append(
      action(
        "Open exact snapshot",
        () => void run(() => openSnapshot(r.source_id)),
      ),
      action(
        "Preview passage into draft",
        () =>
          void run(async () => {
            // Revalidate citation bytes at delivery time; a removed source is never silently reused.
            const credential = token(), scope = localStorage.getItem('orbit.workspace.id') || workspaceId;
            const current = () => !disposed && credential === token() && scope === workspaceId && scope === (localStorage.getItem('orbit.workspace.id') || workspaceId);
            const snap = await request<SourceSnapshot>("get_source", {
              source_id: r.source_id,
            });
            if (!current()) return;
            if (
              snap.text_sha256 !== r.text_sha256 ||
              snap.content_sha256 !== r.content_sha256 || snap.extractor_version !== r.extractor_version ||
              snap.text.slice(r.char_start, r.char_end) !== r.snippet
            )
              throw Error("Citation snapshot changed; search again.");
            const [start, end] = sourceSelectionOffsets(r.snippet, passage.selectionStart, passage.selectionEnd);
            const selected = r.snippet.slice(start, end);
            const result = await requestConversationContext({
              text: formatKnowledgeExcerpt(selected, { sourceId: r.source_id, extractor: r.extractor_version, textSha256: r.text_sha256, contentSha256: snap.content_sha256, start: r.char_start + start, end: r.char_start + end }),
              validate: async () => {
                const fresh = await request<SourceSnapshot>('get_source', { source_id: r.source_id });
                if (!current() || fresh.text_sha256 !== r.text_sha256 || fresh.content_sha256 !== snap.content_sha256 || fresh.extractor_version !== r.extractor_version || fresh.text.slice(r.char_start, r.char_end) !== r.snippet)
                  throw Error('Citation snapshot changed or was removed; search again.');
              },
              title: r.title,
              source: `Snapshot ${r.source_id.slice(0, 16)} · UTF-16 [${r.char_start + (end > start ? start : 0)}, ${r.char_start + (end > start ? end : r.snippet.length)})`,
            });
            if (
              !disposed &&
              result.status !== "delivered" &&
              result.status !== "cancelled"
            )
              error.textContent = `Draft transfer: ${result.status}`;
          }),
      ),
    );
    return item;
  }
  async function search() {
    if (!query.value.trim()) throw Error("Enter a search query.");
    const version = ++queryVersion;
    const response = await request<{ results: SearchResult[]; note: string }>(
      "search",
      {
        query: query.value,
        mode: mode.value,
        ...(filter.value ? { kinds: [filter.value] } : {}),
      },
    );
    if (disposed || version !== queryVersion) return;
    resultList.replaceChildren(
      el("p", "", response.note),
      ...response.results.map(renderResult),
    );
    if (!response.results.length)
      resultList.append(
        el("p", "", "No matching passages. Add a source or try other words."),
      );
  }
  const searchForm = el("form", "knowledge-query");
  searchForm.append(
    field("Query", query),
    field("Mode", mode),
    field("Kind", filter),
    action("Search", () => void run(search)),
  );
  searchForm.onsubmit = (e) => {
    e.preventDefault();
    void run(search);
  };
  const add = el("details", "knowledge-add");
  add.open = true;
  add.append(
    el("summary", "", "Add an explicit source"),
    field("Title", title),
    field("Kind", kind),
    field("Source label", location),
    field("Text (100,000 characters maximum)", text),
    action(
      "Add text",
      () =>
        void run(async () => {
          if (!title.value.trim() || !text.value.trim())
            throw Error("Add a title and source text.");
          await request("ingest_text", {
            kind: kind.value,
            title: title.value,
            text: text.value,
            ...(location.value ? { location: location.value } : {}),
          });
          if (disposed) return;
          text.value = "";
          invalidate();
          await refresh();
        }),
    ),
    field("Owner-picked UTF-8 file (256 KiB maximum)", file),
    action(
      "Add chosen file",
      () =>
        void run(async () => {
          const chosen = file.files?.[0];
          if (!chosen) throw Error("Choose a file first.");
          if (chosen.size > 262144) throw Error("File exceeds 256 KiB.");
          const ext = chosen.name.split(".").pop()?.toLowerCase();
          const mime: Record<string, string> = {
            txt: "text/plain",
            md: "text/markdown",
            csv: "text/csv",
            json: "application/json",
          };
          const media_type = mime[ext ?? ""] ?? chosen.type;
          if (!Object.values(mime).includes(media_type))
            throw Error("Choose a .txt, .md, .csv or .json UTF-8 text file.");
          const bytes = new Uint8Array(await chosen.arrayBuffer());
          let raw = "";
          for (const b of bytes) raw += String.fromCharCode(b);
          await request("ingest_file", {
            filename: chosen.name,
            media_type,
            data_base64: btoa(raw),
          });
          if (disposed) return;
          file.value = "";
          invalidate();
          await refresh();
        }),
    ),
  );
  const manage = el("details");
  manage.append(
    el("summary", "", "Sources and retention"),
    sourceList,
    action("Refresh status and sources", () => void run(refresh)),
    action(
      "Rebuild derived index",
      () =>
        void run(async () => {
          if (
            !confirm(
              "Rebuild this workspace’s derived search index from preserved authoritative snapshots?",
            )
          )
            return;
          await request("reset_index", {
            confirm: true,
            base_consent_generation: generation,
          });
          invalidate();
          await refresh();
        }),
    ),
    action(
      "Purge ingested snapshots",
      () =>
        void run(async () => {
          if (
            !confirm(
              "Delete ALL ingested snapshots for this workspace and exclude them from search? Original files and drafts are untouched; physical erasure is not guaranteed.",
            )
          )
            return;
          await request("purge_snapshots", {
            confirm: true,
            base_consent_generation: generation,
          });
          invalidate();
          await refresh();
        }),
    ),
  );
  root.append(
    el("h2", "", "Local source search"),
    notice,
    status,
    error,
    add,
    searchForm,
    resultList,
    snapshotHost,
    manage,
    grantsHost,
  );
  host.append(root);
  void run(refresh);
  const timer = setInterval(() => {
    if (!busy && !disposed) void run(refresh);
  }, 10000);
  return {
    dispose() {
      disposed = true;
      queryVersion++;
      clearInterval(timer);
      controller.abort();
      grants.dispose();
      root.remove();
    },
  };
}
