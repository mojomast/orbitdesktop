// Published inputs are public bundle bytes, never owner files or API credentials.
export type PublishedDataInput = { path: string; name: string; sha256: string };
export const PUBLISHED_DATA_LIMIT = 5 * 1024 * 1024;
const route = /^orbit:\/\/surface\/data\?input=([a-z0-9][a-z0-9-]{0,79}-[a-f0-9]{24})\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,119}\.csv)&sha256=([a-f0-9]{64})$/;

/** One canonical, credential-free route. No URLs, escapes, traversal or extra keys. */
export function publishedDataInput(url: string): PublishedDataInput | null {
  const match = route.exec(url);
  return match && match[0] === url ? { path: `/apps/${match[1]}/${match[2]}`, name: match[2], sha256: match[3] } : null;
}

export async function fetchPublishedDataInput(url: string, signal: AbortSignal): Promise<File> {
  const input = publishedDataInput(url);
  if (!input) throw Error('Invalid published CSV route.');
  const response = await fetch(input.path, { signal, credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin' });
  if (!response.ok || !response.body) throw Error(`Published CSV unavailable (${response.status}).`);
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > PUBLISHED_DATA_LIMIT) throw Error('Published CSV exceeds 5 MiB.');
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PUBLISHED_DATA_LIMIT) throw Error('Published CSV exceeds 5 MiB.');
      chunks.push(new Uint8Array(value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  signal.throwIfAborted();
  if (!size) throw Error('Published CSV is empty.');
  const file = new File(chunks, input.name, { type: 'text/csv' });
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  signal.throwIfAborted();
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (actual !== input.sha256) throw Error('Published CSV SHA-256 mismatch; nothing loaded.');
  return file;
}
