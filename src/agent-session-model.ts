export type HistoryRow = { session_id: string; profile_id: string; title?: string; upstream_title?: string; updated_at?: string; pinned?: boolean; provider?: string };

export function dateGroup(value: string | undefined, now = Date.now()): 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older' {
  const time = Date.parse(String(value || ''));
  if (!Number.isFinite(time)) return 'Older';
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const day = 86400000;
  if (time >= today) return 'Today';
  if (time >= today - day) return 'Yesterday';
  if (time >= today - 7 * day) return 'Previous 7 days';
  return 'Older';
}

export const HISTORY_GROUPS = ['Today', 'Yesterday', 'Previous 7 days', 'Older'] as const;

export function providerSwitchNote(fromLabel: string, toLabel: string, fromWindow = 0, toWindow = 0) {
  const smaller = toWindow > 0 && fromWindow > 0 && toWindow < fromWindow;
  const text = `Switched from ${fromLabel} to ${toLabel}. This pane stays on ${toLabel}.` +
    (smaller ? ` The new context window (${toWindow}) is smaller than ${fromWindow}. Compact if the conversation no longer fits.` : '');
  return { text, suggestCompact: smaller };
}

export function groupHistory(rows: HistoryRow[], now = Date.now()) {
  const pinned = rows.filter(row => row.pinned);
  const rest = rows.filter(row => !row.pinned);
  const groups = HISTORY_GROUPS.map(label => ({ label, rows: rest.filter(row => dateGroup(row.updated_at, now) === label) }));
  return { pinned, groups: groups.filter(group => group.rows.length) };
}

export function matchesHistoryQuery(row: HistoryRow, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return `${row.title || ''} ${row.upstream_title || ''} ${row.session_id} ${row.profile_id}`.toLocaleLowerCase().includes(needle);
}
