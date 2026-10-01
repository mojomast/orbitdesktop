import { workspaceId, ensureWorkspaceSynced } from "./workspace-sync";
export interface SearchSource {
  source_id: string;
  kind: string;
  title: string;
  location: string;
  content_sha256: string;
  text_sha256: string;
  created_at: number;
  status: string;
}
export interface SearchResult {
  chunk_id: number;
  source_id: string;
  source_kind: string;
  title: string;
  location: string;
  content_sha256: string;
  text_sha256: string;
  extractor_version: string;
  char_start: number;
  char_end: number;
  snippet: string;
  score: number;
  matched: string;
}
export interface SearchStatus {
  source_count: number;
  chunk_count: number;
  semantic_chunk_count: number;
  consent_generation: number;
  indexing: boolean;
  semantic: {
    present: boolean;
    ready: boolean;
    vector_available: boolean;
    note: string;
    id: string;
    revision: string;
    error: string | null;
  };
}
export interface SourceSnapshot {
  source_id: string;
  title: string;
  kind: string;
  location: string;
  text: string;
  data_base64: string;
  content_sha256: string;
  text_sha256: string;
  extractor_version: string;
}
export class SearchError extends Error {
  constructor(
    public code: string,
    public current: unknown,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}
export function createSearchClient(token: () => string, signal: AbortSignal) {
  return async function request<T>(
    action: string,
    fields: Record<string, unknown> = {},
  ): Promise<T> {
    await ensureWorkspaceSynced();
    const credential = token();
    if (!credential)
      throw new SearchError(
        "permission_denied",
        null,
        "Unlock host access to use local search.",
      );
    const response = await fetch("/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ action, workspace_id: workspaceId, ...fields }),
      signal,
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true)
      throw new SearchError(
        result.code ?? "unavailable",
        result.current,
        result.detail,
      );
    return result as T;
  };
}
