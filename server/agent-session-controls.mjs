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

/** Scale a chars/4 estimate toward a gateway total. Factor stays in 0.125–8. */
export function calibrateEstimate(charsEstimate, reportedUsed) {
  const estimate = Number(charsEstimate);
  const reported = Number(reportedUsed);
  if (!Number.isFinite(estimate) || estimate <= 0 || !Number.isFinite(reported) || reported <= 0) return { factor: 1, calibrated: false };
  const factor = Math.min(8, Math.max(0.125, reported / estimate));
  return { factor, calibrated: true };
}

export function applyCalibration(charsEstimate, factor) {
  const estimate = Math.max(0, Math.ceil(Number(charsEstimate) || 0));
  const scale = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return Math.max(0, Math.round(estimate * scale));
}

function usageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function usageBreakdown(session, estimate, chars) {
  const usage = session && typeof session === 'object' && session.usage && typeof session.usage === 'object' ? session.usage : {};
  return {
    input: usageNumber(usage.prompt_tokens ?? usage.input_tokens),
    output: usageNumber(usage.completion_tokens ?? usage.output_tokens),
    tools: usageNumber(usage.tool_tokens ?? usage.tools_tokens),
    chars: Math.max(0, Math.floor(Number(chars) || 0)),
    estimated: Math.max(0, Math.floor(Number(estimate) || 0)),
  };
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

function rawText(message) {
  return String(message?.text || message?.content || '').replace(/\u0000/g, '').trim();
}

function isToolOutput(message) {
  if (!message) return false;
  if (message.tool === true) return true;
  const role = String(message.role || '');
  if (role === 'tool' || role === 'tool_result' || role === 'function') return true;
  return /^(?:tool output|command output|stdout|stderr)\b/i.test(rawText(message));
}

/** Drop every tool output except the newest one. Conversation turns stay. */
export function pruneToolOutputs(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let last = -1;
  for (let index = 0; index < list.length; index += 1) if (isToolOutput(list[index])) last = index;
  if (last < 0) return list.slice();
  return list.filter((message, index) => !isToolOutput(message) || index === last);
}

function pushLine(bucket, text, limit) {
  const line = text.slice(0, 280);
  if (!line || bucket.length >= limit || bucket.includes(line)) return;
  bucket.push(line);
}

/**
 * Extractive summary for an Orbit-owned transcript.
 * Old tool outputs are dropped first. The summary keeps the goal, why a decision
 * was made, plan and status, open TODOs, files, commands and errors, constraints
 * and IDs, the first request, and the last 10 turns.
 */
export function summarizeTranscript(messages) {
  const pruned = pruneToolOutputs(messages);
  const rows = pruned.filter(message => message && (message.role === 'user' || message.role === 'assistant' || isToolOutput(message)) && rawText(message));
  const first = rows.find(message => message.role === 'user');
  const decisions = [];
  const plan = [];
  const todos = [];
  const commands = [];
  const constraints = [];
  const ids = new Set();
  const files = new Set();
  for (const row of rows) {
    const text = textOf(row);
    if (/\b(?:decision|decided|because|why we)\b/i.test(text)) pushLine(decisions, text, 8);
    if (/^(?:plan|status|next)\b/i.test(text)) pushLine(plan, text, 6);
    if (/\b(?:todo|to-do|open task)\b/i.test(text)) pushLine(todos, text, 8);
    if (/(?:^|\s)(?:\$\s|npm\s|pnpm\s|yarn\s|git\s|pytest\s|node\s)/.test(text) || /\b(?:error|failed|exit code)\b/i.test(text)) pushLine(commands, text, 8);
    if (/\b(?:constraint|must not|do not|limit)\b/i.test(text)) pushLine(constraints, text, 8);
    for (const match of text.matchAll(/\b(?:t_|s_|run_|d_|agent_)[A-Za-z0-9_-]{4,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
      if (ids.size < 12) ids.add(match[0]);
    }
    for (const match of text.matchAll(/(?:^|[\s`'"])([\w./-]{1,80}\.[A-Za-z0-9]{1,8})\b/g)) {
      if (files.size < 12) files.add(match[1]);
    }
  }
  const parts = [];
  if (first) parts.push(`Goal: ${textOf(first).slice(0, 500)}`);
  if (first) parts.push(`First request:\n${rawText(first).slice(0, 800)}`);
  if (decisions.length) parts.push(`Decisions:\n- ${decisions.join('\n- ')}`);
  if (plan.length) parts.push(`Plan and status:\n- ${plan.join('\n- ')}`);
  if (todos.length) parts.push(`Open TODOs:\n- ${todos.join('\n- ')}`);
  if (files.size) parts.push(`Files: ${[...files].join(', ')}`);
  if (commands.length) parts.push(`Commands and errors:\n- ${commands.join('\n- ')}`);
  if (constraints.length || ids.size) parts.push(`Constraints and IDs:\n- ${[...constraints, ...ids].join('\n- ')}`);
  parts.push('Recent turns:');
  for (const row of rows.slice(-10)) parts.push(`${row.role}: ${rawText(row).slice(0, 500)}`);
  const summary = parts.join('\n').trim();
  return (summary || 'No earlier messages were available.').slice(0, 8000);
}

export function forkSeed({ summary, sourceSession, sourceProvider, targetProvider, through, cross }) {
  const where = Number.isInteger(through) ? `message ${through + 1}` : 'the latest point';
  const lead = cross
    ? `Forked from ${sourceProvider} session ${sourceSession} into ${targetProvider} with a summary.`
    : `Forked from ${where} of session ${sourceSession}. The original session stays unchanged.`;
  return `${lead}\n\n${summary}\n\nContinue from this summary.`.slice(0, 16000);
}

export const HERMES_COMPRESSION_NOTE = 'Hermes keeps the first 3 turns and the last 20 messages. Orbit does not summarize that session again.';
