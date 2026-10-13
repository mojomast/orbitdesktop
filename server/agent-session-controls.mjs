/** Context meter and compact summary shared by the agent pane. */

export const DEFAULT_CONTEXT_WINDOW = 128000;

export function modelWindow(model) {
  const name = String(model || '').toLowerCase();
  if (/1[,.]?0{6}|1m\b|million/.test(name)) return 1000000;
  if (/200[,.]?000|200k/.test(name)) return 200000;
  if (/32[,.]?768|32k/.test(name)) return 32768;
  if (/8[,.]?192|8k\b/.test(name)) return 8192;
  return DEFAULT_CONTEXT_WINDOW;
}

export function estimateTokens(text) {
  return Math.max(0, Math.ceil(String(text || '').length / 4));
}

export function meterLevel(used, limit) {
  const window = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_CONTEXT_WINDOW;
  const tokens = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
  const ratio = tokens / window;
  const level = ratio >= 0.8 ? 'hot' : ratio >= 0.6 ? 'warn' : 'ok';
  return { used: tokens, window, ratio, level };
}

export function readReportedUsage(session) {
  if (!session || typeof session !== 'object') return { model: '', window: 0, used: 0 };
  const used = Number(session.usage?.total_tokens ?? session.usage?.totalTokens ?? session.context_tokens ?? session.token_count);
  const model = typeof session.model === 'string' ? session.model : typeof session.model_name === 'string' ? session.model_name : '';
  const window = Number(session.context_length ?? session.context_window ?? session.max_tokens);
  return {
    model: model.slice(0, 120),
    window: Number.isFinite(window) && window > 0 ? Math.floor(window) : 0,
    used: Number.isFinite(used) && used > 0 ? Math.floor(used) : 0,
  };
}

function textOf(message) {
  return String(message?.text || message?.content || '').replace(/\s+/g, ' ').trim();
}

/** Extractive summary: first request, decision lines, file names, and the last 10 turns. */
export function summarizeTranscript(messages) {
  const rows = (Array.isArray(messages) ? messages : []).filter(message => message && (message.role === 'user' || message.role === 'assistant') && textOf(message));
  const first = rows.find(message => message.role === 'user');
  const decisions = [];
  const files = new Set();
  for (const row of rows) {
    const text = textOf(row);
    if (/^(decision|decided|we will|constraint|todo)\b/i.test(text) && decisions.length < 8) decisions.push(text.slice(0, 240));
    for (const match of text.matchAll(/(?:^|[\s`'"])([\w./-]{1,80}\.[A-Za-z0-9]{1,8})\b/g)) {
      if (files.size < 12) files.add(match[1]);
    }
  }
  const parts = [];
  if (first) parts.push(`Goal: ${textOf(first).slice(0, 500)}`);
  if (decisions.length) parts.push(`Decisions:\n- ${decisions.join('\n- ')}`);
  if (files.size) parts.push(`Files: ${[...files].join(', ')}`);
  parts.push('Recent turns:');
  for (const row of rows.slice(-10)) parts.push(`${row.role}: ${textOf(row).slice(0, 400)}`);
  const summary = parts.join('\n').trim();
  return (summary || 'No earlier messages were available.').slice(0, 4000);
}

export const HERMES_COMPRESSION_NOTE = 'Hermes keeps the first 3 turns and the last 20 messages. Orbit does not summarize that session again.';
