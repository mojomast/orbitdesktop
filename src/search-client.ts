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
export interface SearchStatus {
  source_count: number;
  chunk_count: number;
  consent_generation: number;
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
        "Unlock host access to use shared sources.",
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
