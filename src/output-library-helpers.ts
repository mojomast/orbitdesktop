// Pure helpers for the published-output library. No DOM and no CSS imports, so
// the same functions are shared by the browser view (src/output-library.ts) and
// the owner-only metadata service (server/output-library.mjs). They never read
// file bytes and never turn an untrusted title into HTML.

export const OUTPUT_LIBRARY_LIMITS = Object.freeze({
  maxItems: 500,
  maxTagsPerItem: 12,
  maxTagLength: 40,
  maxAliasLength: 120,
  maxTitleLength: 200,
  maxUrlLength: 1024,
  maxReferenceLength: 600,
});

export type OutputKind = 'app/report' | 'output';
export type OutputKindFilter = OutputKind | 'all';

/** A deliberately published file advertised by the workspace shelf action. */
export interface ShelfEntry {
  title: string;
  url: string;
  kind: OutputKind;
}

export interface OutputMetadata {
  alias: string | null;
  pinned: boolean;
  tags: string[];
}

/** A shelf entry joined with its durable owner metadata. */
export interface OutputItem extends ShelfEntry, OutputMetadata {
  item_id: string;
  display_title: string;
}

export interface OutputFilter {
  query?: string;
  kind?: OutputKindFilter;
  pinnedOnly?: boolean;
  tag?: string;
}

export interface MetadataRecord {
  url: string;
  alias: string | null;
  pinned: boolean;
  tags: string[];
  updated_at: number;
}

export interface MetadataSnapshot {
  revision: number;
  items: Record<string, MetadataRecord>;
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const isWorkspaceId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export interface DecodedAppUrl {
  slug: string;
  relative: string;
  /** Canonical immutable identity: `/apps/<full slug>/<decoded relative>`. */
  canonical: string;
}

/**
 * Decode a published file URL without URL parsing or double-decoding.
 *
 * Metadata and identity are keyed by the exact immutable resource URL, so this
 * is intentionally conservative and mirrors `server/workspace.mjs#serveApp`
 * (raw `/apps/` prefix, single `decodeURIComponent` per path segment):
 *  - the raw string must start with `/apps/` (absolute/synthetic origins and
 *    protocol-relative `//` are refused before any normalization);
 *  - no raw `?`, `#`, backslash or control characters;
 *  - each raw segment is decoded exactly once; a decoded `/`, `\`, control
 *    character, empty, `.` or `..` segment (or hidden `.` name) is refused, so
 *    encoded slashes and traversal never change the path structure;
 *  - `%252f` decodes once to a literal `%2f` filename and stays one segment,
 *    matching server semantics.
 */
export function decodeAppUrl(url: unknown): DecodedAppUrl | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > OUTPUT_LIBRARY_LIMITS.maxUrlLength) return null;
  if (!url.startsWith('/apps/') || url.startsWith('/apps//')) return null;
  if (url.includes('?') || url.includes('#') || url.includes('\\') || CONTROL.test(url)) return null;
  const parts = url.slice('/apps/'.length).split('/');
  const slug = parts.shift() ?? '';
  if (!SLUG.test(slug) || parts.length === 0) return null;
  const segments: string[] = [];
  for (const raw of parts) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!segment || segment === '.' || segment === '..' || segment.startsWith('.')) return null;
    if (segment.includes('/') || segment.includes('\\') || CONTROL.test(segment)) return null;
    segments.push(segment);
  }
  const relative = segments.join('/');
  return { slug, relative, canonical: `/apps/${slug}/${relative}` };
}

/**
 * Stable metadata key for a published file: the canonical immutable resource
 * path. Multiple releases of the same logical app are distinct resources;
 * aliases, pins and tags never carry across a content hash change.
 */
export function shelfItemId(url: unknown): string | null {
  return decodeAppUrl(url)?.canonical ?? null;
}

/** Coerce an untrusted shelf response into bounded entries. Invalid rows are
 * dropped rather than rendered. Titles are never interpreted as markup. */
export function sanitizeShelfEntries(raw: unknown): ShelfEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ShelfEntry[] = [];
  for (const entry of raw.slice(0, OUTPUT_LIBRARY_LIMITS.maxItems)) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.title !== 'string' || typeof candidate.url !== 'string') continue;
    const decoded = decodeAppUrl(candidate.url);
    if (!decoded) continue;
    // Older shelf responses and fixtures may omit kind; infer it rather than
    // dropping an otherwise valid published file.
    const kind: OutputKind = candidate.kind === 'app/report' || candidate.kind === 'output'
      ? candidate.kind
      : /\.html?$/i.test(decoded.relative) ? 'app/report' : 'output';
    out.push({
      title: candidate.title.slice(0, OUTPUT_LIBRARY_LIMITS.maxTitleLength),
      url: candidate.url,
      kind,
    });
  }
  return out;
}

export function normalizeMetadata(raw: unknown): OutputMetadata {
  if (!raw || typeof raw !== 'object') return { alias: null, pinned: false, tags: [] };
  const candidate = raw as Record<string, unknown>;
  const alias = typeof candidate.alias === 'string' && candidate.alias.trim()
    ? candidate.alias.trim().slice(0, OUTPUT_LIBRARY_LIMITS.maxAliasLength)
    : null;
  return {
    alias,
    pinned: candidate.pinned === true,
    tags: normalizeTags(candidate.tags),
  };
}

/** Trim, deduplicate (case-insensitively) and bound a tag list. */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const tag = value.trim().slice(0, OUTPUT_LIBRARY_LIMITS.maxTagLength);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= OUTPUT_LIBRARY_LIMITS.maxTagsPerItem) break;
  }
  return tags;
}

/** Join a validated shelf entry with (possibly absent) metadata. */
export function joinOutputItem(entry: ShelfEntry, metadata: OutputMetadata | undefined): OutputItem | null {
  const item_id = shelfItemId(entry.url);
  if (!item_id) return null;
  const normalized = normalizeMetadata(metadata);
  return {
    ...entry,
    item_id,
    ...normalized,
    display_title: normalized.alias ?? entry.title,
  };
}

/** Case-insensitive substring search across display title, original title,
 * alias, tags and URL. Empty filters match everything. */
export function filterOutputItems(items: readonly OutputItem[], filter: OutputFilter = {}): OutputItem[] {
  const query = (filter.query ?? '').trim().toLowerCase();
  const kind = filter.kind ?? 'all';
  const tag = (filter.tag ?? '').trim().toLowerCase();
  return items.filter(item => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (filter.pinnedOnly && !item.pinned) return false;
    if (tag && !item.tags.some(value => value.toLowerCase() === tag)) return false;
    if (!query) return true;
    const haystack = [item.display_title, item.title, item.alias ?? '', item.url, ...item.tags].join('\n').toLowerCase();
    return haystack.includes(query);
  });
}

/**
 * A bounded, human-readable reference to a published output. It contains only
 * the title, public URL, kind and tags — never file contents or credentials.
 * Nothing is sent automatically; the caller hands this text to the conversation
 * draft for explicit owner review.
 */
export function outputReferenceText(item: OutputItem): string {
  const lines = [`Published output reference: ${item.display_title}`];
  if (item.alias && item.alias !== item.title) lines.push(`Published title: ${item.title}`);
  lines.push(`URL: ${item.url}`, `Kind: ${item.kind}`);
  if (item.tags.length) lines.push(`Tags: ${item.tags.join(', ')}`);
  lines.push('Reference only; file contents were not fetched. Open the preview to inspect the output.');
  return lines.join('\n').slice(0, OUTPUT_LIBRARY_LIMITS.maxReferenceLength);
}
