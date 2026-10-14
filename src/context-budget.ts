/** Token budget, compaction, and history grouping for the agent pane.
 * Orbit does not bundle a model tokenizer. Prose uses ceil(chars/4) and
 * code or JSON uses ceil(chars/3). A later reported usage recalibrates that
 * estimate with reported/estimated, clamped so one odd reply cannot run away.
 */

import type { AgentProvider } from './agent-providers.ts';

export const AUTO_COMPACT_RATIO = 0.8;
export const CONTEXT_SYSTEM_TEXT = 'Orbit agent instructions and conversation frame. ';
export const CONTEXT_TOOLS_TEXT = 'tool schema allowance '.repeat(40);

const CODE_HINT = /```|^\s*(?:function|const|let|import|class|export)\b|[{}[\];]/m;

export type BudgetMessage = { role?: string; text?: string; content?: string; kind?: string };

export function estimateTokens(text: unknown): number {
  const value = typeof text === 'string' ? text : '';
  if (!value) return 0;
  const code = CODE_HINT.test(value) && (value.includes('{') || value.includes('```') || value.trim().startsWith('[') || value.trim().startsWith('{'));
  return Math.ceil(value.length / (code ? 3 : 4));
}

export function isToolOutput(message: BudgetMessage | null | undefined): boolean {
  if (!message) return false;
  if (message.kind === 'tool' || message.role === 'tool') return true;
  const text = String(message.text || message.content || '').trim();
  if (/^(?:tool result|tool output|\[tool\b)/i.test(text)) return true;
  if ((text.startsWith('{') || text.startsWith('[')) && text.length > 400) {
    try { JSON.parse(text); return true; } catch { return false; }
  }
  return false;
}

export function calibrate(estimated: number, reported: number): number | null {
  if (!Number.isFinite(estimated) || estimated <= 0 || !Number.isFinite(reported) || reported < 0) return null;
  const ratio = reported / estimated;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return Math.min(4, Math.max(0.25, ratio));
}

export function applyCalibration(estimated: number, ratio: number | null | undefined): number {
  if (!Number.isFinite(estimated) || estimated <= 0) return 0;
  if (!Number.isFinite(ratio || NaN) || !ratio || ratio <= 0) return Math.ceil(estimated);
  return Math.ceil(estimated * ratio);
}

export type ContextMeasure = {
  source: 'reported' | 'estimated';
  used: number;
  estimated: number;
  breakdown: { system: number; tools: number; history: number; files: number };
  ratio: number | null;
};

export function measureContext({ messages = [], system = CONTEXT_SYSTEM_TEXT, tools = '', files = '', reported, ratio }: {
  messages?: BudgetMessage[];
  system?: string;
  tools?: string;
  files?: string;
  reported?: number;
  ratio?: number | null;
} = {}): ContextMeasure {
  const breakdown = {
    system: estimateTokens(system),
    tools: estimateTokens(tools),
    history: messages.reduce((sum, message) => sum + estimateTokens(message?.text || message?.content || ''), 0),
    files: estimateTokens(files),
  };
  const estimated = breakdown.system + breakdown.tools + breakdown.history + breakdown.files;
  const calibrated = applyCalibration(estimated, ratio);
  const hasReported = Number.isFinite(reported) && (reported as number) >= 0;
  return {
    source: hasReported ? 'reported' : 'estimated',
    used: hasReported ? Math.round(reported as number) : calibrated,
    estimated: calibrated,
    breakdown,
    ratio: hasReported ? calibrate(estimated, reported as number) : (Number.isFinite(ratio || NaN) ? ratio || null : null),
  };
}

export function meterLevel(used: number, window: number): 'ok' | 'warn' | 'hot' {
  if (!Number.isFinite(window) || window <= 0 || !Number.isFinite(used) || used <= 0) return 'ok';
  const ratio = used / window;
  if (ratio >= AUTO_COMPACT_RATIO) return 'hot';
  if (ratio >= 0.6) return 'warn';
  return 'ok';
}

export function shouldAutoCompact(used: number, window: number): boolean {
  return meterLevel(used, window) === 'hot';
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 10000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(value));
}

export function meterLabel(measure: ContextMeasure, window: number): string {
  const kind = measure.source === 'reported' ? 'reported' : '≈ estimated';
  return `${formatTokens(measure.used)} / ${formatTokens(window)} · ${kind}`;
}

/** Known windows. `window-<tokens>` is an explicit size for a configured label. */
export function contextWindowFor(model: string | undefined, provider: AgentProvider): number {
  const name = String(model || '');
  const sized = /^window-(\d{2,7})$/.exec(name);
  if (sized) return Number(sized[1]);
  const table: [RegExp, number][] = [
    [/gemini/i, 1000000],
    [/claude/i, 200000],
    [/grok-4/i, 256000],
    [/grok/i, 131072],
    [/gpt-4o|gpt-4\.1|o1|o3|o4/i, 128000],
    [/deepseek/i, 128000],
  ];
  for (const [pattern, size] of table) if (pattern.test(name)) return size;
  // Pi has no model-name patterns of its own; its window comes from its own
  // profile, so fall back to the 128000 default. Grok keeps its 131072 default.
  return provider === 'grok' ? 131072 : 128000;
}

export function smallerWindow(used: number, nextWindow: number): boolean {
  return Number.isFinite(used) && Number.isFinite(nextWindow) && nextWindow > 0 && used > nextWindow;
}

export function dateGroup(iso: string | undefined, now = new Date()): 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older' {
  const time = Date.parse(String(iso || ''));
  if (!Number.isFinite(time)) return 'Older';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const then = new Date(time);
  const day = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const days = Math.round((today - day) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 7) return 'Previous 7 days';
  return 'Older';
}

export const DATE_GROUP_ORDER = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older'] as const;

function linesMatching(text: string, patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const line of text.split('\n').map(item => item.trim()).filter(Boolean)) {
    if (patterns.some(pattern => pattern.test(line))) hits.push(line.slice(0, 240));
    if (hits.length >= 8) break;
  }
  return hits;
}

function turnsOf(messages: { role: 'user' | 'assistant'; text: string }[]): { role: 'user' | 'assistant'; text: string }[][] {
  const turns: { role: 'user' | 'assistant'; text: string }[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || !turns.length) turns.push([message]);
    else turns[turns.length - 1].push(message);
  }
  return turns;
}

export type CompactResult = {
  view: { role: 'user' | 'assistant'; text: string }[];
  raw: { role: string; text: string }[];
  summary: string;
  pruned_tools: number;
};

/** Prune old tool output, then summarize the middle. First user request and the last 10 turns stay verbatim. */
export function compactTranscript(messages: BudgetMessage[], keepTurns = 10): CompactResult {
  const list = (Array.isArray(messages) ? messages : []).flatMap(message => {
    const text = String(message?.text || message?.content || '');
    if (!text.trim()) return [];
    const role = message.role === 'user' ? 'user' : message.role === 'tool' || message.kind === 'tool' ? 'tool' : 'assistant';
    return [{ role, text, tool: isToolOutput({ ...message, role, text }) }];
  });
  const raw = list.map(({ role, text }) => ({ role, text }));
  const pruned = list.filter(message => !message.tool).map(({ role, text }) => ({ role: role === 'user' ? 'user' as const : 'assistant' as const, text }));
  const first = pruned.find(message => message.role === 'user');
  const tail = turnsOf(pruned).slice(-Math.max(1, keepTurns)).flat();
  const kept = new Set(tail);
  if (first) kept.add(first);
  const middle = pruned.filter(message => !kept.has(message));
  const corpus = pruned.map(message => message.text).join('\n');
  const files = [...corpus.matchAll(/(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:ts|js|mjs|py|md|json))/g)].map(match => match[1]).slice(0, 12);
  const summary = [
    `Summary of ${middle.length} earlier messages`,
    first ? `Goal: ${first.text.slice(0, 500)}` : 'Goal: (not stated)',
    `Decisions: ${linesMatching(corpus, [/decided/i, /decision/i, /because/i, /chose/i]).join(' | ') || '(none recorded)'}`,
    `Plan: ${linesMatching(corpus, [/\bplan\b/i, /\bstatus\b/i, /\bnext\b/i]).join(' | ') || '(none recorded)'}`,
    `Open TODOs: ${linesMatching(corpus, [/\btodo\b/i, /open question/i, /\bFIXME\b/, /- \[ \]/]).join(' | ') || '(none recorded)'}`,
    `Files: ${files.join(', ') || '(none recorded)'}`,
    `Commands: ${linesMatching(corpus, [/^(?:\$ |npm |pnpm |yarn |git |node |pytest |error:|Error:|failed\b)/, /\bcommand\b/i]).join(' | ') || '(none recorded)'}`,
    `Constraints: ${linesMatching(corpus, [/\bmust\b/i, /constraint/i, /do not /i, /\b(?:PR|session|task)[-_ ]?#?[A-Za-z0-9_-]+/]).join(' | ') || '(none recorded)'}`,
  ].join('\n').slice(0, 8000);
  const view: { role: 'user' | 'assistant'; text: string }[] = [];
  view.push(first ? { role: 'user', text: first.text } : { role: 'user', text: 'Continue from the compacted transcript.' });
  view.push({ role: 'assistant', text: summary });
  for (const message of tail) {
    if (message === first) continue;
    if (view.at(-1)?.role === message.role && view.at(-1)?.text === message.text) continue;
    view.push(message);
  }
  const head = view.slice(0, 2);
  const tailView = view.slice(2).slice(-(100 - head.length));
  return { view: [...head, ...tailView], raw, summary, pruned_tools: list.length - pruned.length };
}
