const safeId = /^[A-Za-z0-9_:-]{1,128}$/;
const profileId = /^[A-Za-z0-9_-]{1,64}$/;

export function validSessionId(id) {
  return typeof id === 'string' && safeId.test(id);
}
export const validateSessionId = validSessionId;

function invalidConfig() {
  // Configuration errors must not echo credentials or URLs into logs/responses.
  throw new Error('Invalid Hermes profiles configuration.');
}

function origin(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s\\/?#]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(value)) invalidConfig();
  let url;
  try { url = new URL(value); } catch { invalidConfig(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) invalidConfig();
  return url.origin + url.pathname.replace(/\/$/, '');
}

function parseProfiles(value) {
  if (typeof value !== 'string') invalidConfig();
  try { return JSON.parse(value); } catch { invalidConfig(); }
}

/** Credentials are returned only by get; expose list to browsers. */
export function createAgentProfiles({ profiles, apiUrl = process.env.HERMES_API_URL, apiKey = process.env.HERMES_API_KEY, profilesJson } = {}) {
  if (profiles === undefined && profilesJson === undefined) profilesJson = process.env.HERMES_PROFILES_JSON;
  if (profiles !== undefined && profilesJson !== undefined) invalidConfig();
  let entries;
  if (profiles !== undefined || profilesJson !== undefined) entries = profiles === undefined ? parseProfiles(profilesJson) : profiles;
  else entries = [];

  if (!Array.isArray(entries) || entries.length > 100) invalidConfig();
  entries = [...entries];
  if (apiUrl || apiKey) {
    if (!apiUrl || !apiKey) invalidConfig();
    entries.unshift({ id: 'default', label: 'Default', apiUrl, apiKey });
  }
  if (entries.length > 100) invalidConfig();
  const byId = new Map();
  const list = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['id', 'label', 'apiUrl', 'apiKey'].includes(key)) ||
        !['id', 'label', 'apiUrl', 'apiKey'].every(key => Object.hasOwn(entry, key)) ||
        typeof entry.id !== 'string' || !profileId.test(entry.id) || byId.has(entry.id) ||
        typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 200 || /[\x00-\x1f\x7f]/.test(entry.label) ||
        typeof entry.apiKey !== 'string' || !entry.apiKey.trim()) invalidConfig();
    const profile = Object.freeze({ id: entry.id, label: entry.label, apiUrl: origin(entry.apiUrl), apiKey: entry.apiKey, legacy: entry.id === 'default' && !!apiUrl });
    byId.set(profile.id, profile);
    list.push(Object.freeze({ id: profile.id, label: profile.label }));
  }
  Object.freeze(list);
  function get(id) { return byId.get(id) || null; }
  function resolveRun(id) {
    const profile = get(id);
    return profile ? { url: `${profile.apiUrl}/v1/runs`, apiKey: profile.apiKey } : null;
  }
  function runPath(id) {
    return get(id) ? `${new URL(get(id).apiUrl).pathname.replace(/\/$/, '')}/v1/runs` : null;
  }
  return Object.freeze({ list, get, defaultId: 'default', resolveRun, runPath });
}

/** Keep only safe identifiers and display fields from Hermes's sessions page. */
export function sanitizeSessions(page) {
  const data = Array.isArray(page) ? page : Array.isArray(page?.data) ? page.data : [];
  return {
    data: data.slice(0, 100).filter(item => item && validSessionId(item.id)).map(item => ({
      id: item.id,
      title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
      updated_at: typeof item.updated_at === 'string' ? item.updated_at.slice(0, 100) : '',
    })),
    has_more: page?.has_more === true || data.length > 100,
  };
}
export const sanitizeSessionList = sanitizeSessions;

/** Newest 80 user/assistant text messages, bounded for both display and replay. */
export function sanitizeHistory(page) {
  const data = Array.isArray(page) ? page : Array.isArray(page?.data) ? page.data : [];
  const result = [];
  let remaining = 120000;
  for (let i = data.length - 1; i >= 0 && result.length < 80 && remaining > 0; i--) {
    const item = data[i];
    if (!item || !['user', 'assistant'].includes(item.role) || item.tool_calls?.length) continue;
    const raw = typeof item.content === 'string' ? item.content : item.text;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const text = raw.slice(0, Math.min(16000, remaining));
    if (!text.trim()) continue;
    result.unshift({ role: item.role, text });
    remaining -= text.length;
  }
  while (result.length && result[0].role !== 'user') result.shift();
  return result;
}
export const sanitizeTextHistory = sanitizeHistory;
