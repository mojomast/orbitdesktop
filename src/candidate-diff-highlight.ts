import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import type { DiffLine } from './candidate-diff-types';

for (const [name, grammar] of Object.entries({ typescript, javascript, json, python, go, rust, sql, xml, css, markdown, bash, yaml, ini })) hljs.registerLanguage(name, grammar);
const languages: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', py: 'python', go: 'go', rs: 'rust', sql: 'sql', html: 'xml', xml: 'xml', svg: 'xml', css: 'css', md: 'markdown', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', ini: 'ini', toml: 'ini' };
interface TokenNode { scope?: string; children: (TokenNode | string)[] }

// Walk highlight.js's token tree, never its HTML. All source enters DOM as text.
export function renderDiffLine(target: HTMLElement, line: DiffLine, path: string, query: string): void {
  const ranges: { start: number; end: number; className: string }[] = [];
  let offset = 0;
  for (const token of line.tokens ?? []) {
    if (token.changed) ranges.push({ start: offset, end: offset + token.text.length, className: 'cdv-word' });
    offset += token.text.length;
  }
  if (query) {
    const lower = line.text.toLowerCase();
    // Search navigation counts side-lines, not individual occurrences. Bound the
    // decorations on a repetitive/minified line without omitting source text.
    let decorated = 0;
    for (let at = lower.indexOf(query); at >= 0 && decorated < 128; at = lower.indexOf(query, at + query.length), decorated++) ranges.push({ start: at, end: at + query.length, className: 'cdv-match' });
  }
  offset = 0;
  const append = (parent: HTMLElement, text: string) => {
    const start = offset;
    const end = offset += text.length;
    const touching = ranges.filter(r => r.start < end && r.end > start);
    const cuts = [...new Set([start, end, ...touching.flatMap(r => [Math.max(start, r.start), Math.min(end, r.end)])])].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i]!; const b = cuts[i + 1]!;
      const classes = touching.filter(r => r.start <= a && r.end >= b).map(r => r.className);
      const node = document.createElement('span');
      node.className = classes.join(' ');
      node.textContent = text.slice(a - start, b - start);
      parent.append(node);
    }
  };
  const walk = (parent: HTMLElement, node: TokenNode | string) => {
    if (typeof node === 'string') { append(parent, node); return; }
    const child = node.scope ? document.createElement('span') : parent;
    if (node.scope) { child.className = `hljs-${node.scope.replace(/[^a-zA-Z0-9_-]/g, '-')}`; parent.append(child); }
    node.children.forEach(n => walk(child, n));
  };
  const language = languages[path.split('.').pop()?.toLowerCase() ?? ''];
  if (language && line.text.length <= 12000) {
    try {
      const result = hljs.highlight(line.text, { language, ignoreIllegals: true }) as unknown as { _emitter?: { rootNode: TokenNode } };
      if (result._emitter?.rootNode) { walk(target, result._emitter.rootNode); return; }
    } catch { /* Unsupported syntax remains readable plain text. */ }
  }
  append(target, line.text);
}
