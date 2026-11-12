// Pure helpers for the Repos to watch field (no DOM, no CSS), shared with tests.
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const MAX_WATCHED_REPOS = 50;

/** Split free text (commas, spaces, newlines, GitHub URLs) into unique owner/name entries. */
export function parseRepoInput(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let token of String(text ?? '').split(/[\s,]+/)) {
    token = token.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

export function repoInputError(repos: string[]): string {
  if (repos.length > MAX_WATCHED_REPOS) return `At most ${MAX_WATCHED_REPOS} repositories can be watched.`;
  const bad = repos.find(repo => !REPO_PATTERN.test(repo) || ['.', '..'].includes(repo.split('/')[1] ?? ''));
  return bad ? `"${bad.slice(0, 80)}" is not owner/name (for example octo/hello-world).` : '';
}

