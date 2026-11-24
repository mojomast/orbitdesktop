// Dependency-free text slop checker with a per-file+rule baseline ratchet.
// Scans source text for a few known patterns. This is intentionally not a
// parser: strings and comments are stripped before matching so text inside
// them is never reported.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.mts']);
const MESSAGES = {
  'empty-catch': 'empty catch block',
  'as-any': '`as any` type assertion',
  'ts-ignore': '`@ts-ignore` comment',
};

function blank(out, source, from, to) {
  for (let i = from; i < to && i < out.length; i++) {
    if (source[i] !== '\n') out[i] = ' ';
  }
}

// Returns two same-length views of the source: `code` with strings and
// comments blanked, and `noComments` with comments blanked only (strings kept,
// so an empty-catch body containing a literal is still seen as non-empty).
function strip(source) {
  const code = source.split('');
  const noComments = source.split('');
  const comments = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const start = i;
      let text = '';
      while (i < n && source[i] !== '\n') {
        text += source[i];
        i++;
      }
      comments.push({text, line});
      blank(code, source, start, i);
      blank(noComments, source, start, i);
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const start = i;
      const startLine = line;
      let text = '/*';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        text += source[i];
        i++;
      }
      if (i < n) {
        text += '*/';
        i += 2;
      }
      comments.push({text, line: startLine});
      blank(code, source, start, i);
      blank(noComments, source, start, i);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        const d = source[i];
        if (d === '\\') {
          if (source[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        if (d === quote) {
          i++;
          break;
        }
        if (d === '\n') line++;
        i++;
      }
      blank(code, source, start, i);
      continue;
    }
    if (c === '\n') line++;
    i++;
  }
  return {code: code.join(''), noComments: noComments.join(''), comments};
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function matchPair(text, open, opener, closer) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === opener) depth++;
    else if (text[i] === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchPairBack(text, close, opener, closer) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (text[i] === closer) depth++;
    else if (text[i] === opener) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isWordChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

export function scanSource(source, filePath) {
  const text = String(source);
  const {code, noComments, comments} = strip(text);
  const findings = [];

  const asAny = /\bas\s+any\b/g;
  let match;
  while ((match = asAny.exec(code)) !== null) {
    findings.push({path: filePath, line: lineAt(code, match.index), rule: 'as-any', message: MESSAGES['as-any']});
  }

  for (const comment of comments) {
    const ignore = /@ts-ignore\b/g;
    let hit;
    while ((hit = ignore.exec(comment.text)) !== null) {
      let line = comment.line;
      for (let i = 0; i < hit.index; i++) {
        if (comment.text[i] === '\n') line++;
      }
      findings.push({path: filePath, line, rule: 'ts-ignore', message: MESSAGES['ts-ignore']});
    }
  }

  const catchRe = /\bcatch\b/g;
  while ((match = catchRe.exec(code)) !== null) {
    const at = match.index;
    const prev = code[at - 1];
    if (prev === '.' || isWordChar(prev)) continue;
    let before = at - 1;
    while (before >= 0 && /\s/.test(code[before])) before--;
    if (code[before] !== '}') continue;
    const tryOpen = matchPairBack(code, before, '{', '}');
    if (tryOpen < 0) continue;
    let tryAt = tryOpen - 1;
    while (tryAt >= 0 && /\s/.test(code[tryAt])) tryAt--;
    if (code.slice(tryAt - 2, tryAt + 1) !== 'try' || isWordChar(code[tryAt - 3])) continue;
    let cursor = at + 'catch'.length;
    while (cursor < code.length && /\s/.test(code[cursor])) cursor++;
    if (code[cursor] === '(') {
      const close = matchPair(code, cursor, '(', ')');
      if (close < 0) continue;
      cursor = close + 1;
      while (cursor < code.length && /\s/.test(code[cursor])) cursor++;
    }
    if (code[cursor] !== '{') continue;
    const end = matchPair(code, cursor, '{', '}');
    if (end < 0) continue;
    if (noComments.slice(cursor + 1, end).trim() === '') {
      findings.push({path: filePath, line: lineAt(code, at), rule: 'empty-catch', message: MESSAGES['empty-catch']});
    }
  }

  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return findings;
}

export function countFindings(findings) {
  const counts = {};
  for (const finding of findings) {
    const perRule = counts[finding.path] ?? (counts[finding.path] = {});
    perRule[finding.rule] = (perRule[finding.rule] ?? 0) + 1;
  }
  return counts;
}

function sortedRules(object) {
  return Object.keys(object).sort((a, b) => a.localeCompare(b));
}

export function compare(current, baseline) {
  const added = [];
  const fixed = [];
  const currentPaths = sortedRules(current ?? {});
  for (const filePath of currentPaths) {
    for (const rule of sortedRules(current[filePath] ?? {})) {
      const count = current[filePath][rule];
      const base = baseline?.[filePath]?.[rule] ?? 0;
      if (count > base) added.push({path: filePath, rule, count, baseline: base});
    }
  }
  const baselinePaths = sortedRules(baseline ?? {});
  for (const filePath of baselinePaths) {
    for (const rule of sortedRules(baseline[filePath] ?? {})) {
      const base = baseline[filePath][rule];
      const count = current?.[filePath]?.[rule] ?? 0;
      if (count < base) fixed.push({path: filePath, rule, count, baseline: base});
    }
  }
  return {added, fixed};
}

function usageError(message) {
  console.error(`slop-lint: ${message}`);
  process.exit(2);
}

function loadBaseline(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    usageError(`cannot read baseline: ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    usageError(`baseline is not valid JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    usageError(`baseline must be a JSON object: ${file}`);
  }
  for (const filePath of Object.keys(parsed)) {
    const perRule = parsed[filePath];
    if (!perRule || typeof perRule !== 'object' || Array.isArray(perRule)) {
      usageError(`baseline entry for ${filePath} must be an object`);
    }
    for (const rule of Object.keys(perRule)) {
      const count = perRule[rule];
      if (!Number.isInteger(count) || count < 0) {
        usageError(`baseline count for ${filePath}/${rule} must be a non-negative integer`);
      }
    }
  }
  return parsed;
}

function skipDir(name) {
  return name.startsWith('.') || name === 'node_modules';
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function collectFiles(inputs) {
  const cwd = process.cwd();
  const files = new Map();
  const visit = (abs) => {
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      usageError(`cannot read path: ${abs}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs, {withFileTypes: true})) {
        if (entry.isDirectory()) {
          if (!skipDir(entry.name)) visit(path.join(abs, entry.name));
        } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
          add(path.join(abs, entry.name));
        }
      }
    } else if (stat.isFile()) {
      if (EXTENSIONS.has(path.extname(abs))) add(abs);
    } else {
      usageError(`not a file or directory: ${abs}`);
    }
  };
  const add = (abs) => {
    const rel = toPosix(path.relative(cwd, abs));
    const key = rel || toPosix(abs);
    files.set(key, abs);
  };
  for (const input of inputs) visit(path.resolve(cwd, input));
  return [...files.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([rel, abs]) => ({rel, abs}));
}

function scanPaths(inputs) {
  const findings = [];
  for (const {rel, abs} of collectFiles(inputs)) {
    findings.push(...scanSource(fs.readFileSync(abs, 'utf8'), rel));
  }
  return findings;
}

function writeCounts(file, counts) {
  const ordered = {};
  for (const filePath of sortedRules(counts)) {
    ordered[filePath] = {};
    for (const rule of sortedRules(counts[filePath])) ordered[filePath][rule] = counts[filePath][rule];
  }
  fs.writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`);
}

function parseCli(argv) {
  const options = {command: argv[0], paths: [], baseline: null, write: null, reportOnly: false, passOnUnpruned: false};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--baseline' || arg === '--write') {
      const value = argv[++i];
      if (!value) usageError(`${arg} needs a file`);
      if (arg === '--baseline') options.baseline = value;
      else options.write = value;
    } else if (arg === '--report-only') {
      options.reportOnly = true;
    } else if (arg === '--pass-on-unpruned') {
      options.passOnUnpruned = true;
    } else if (arg.startsWith('--')) {
      usageError(`unknown option: ${arg}`);
    } else {
      options.paths.push(arg);
    }
  }
  return options;
}

function main(argv) {
  const options = parseCli(argv);
  const {command, paths} = options;
  if (command !== 'check' && command !== 'baseline' && command !== 'prune') {
    usageError('expected check, baseline or prune');
  }
  if (paths.length === 0) usageError(`${command} needs at least one path`);

  if (command === 'baseline') {
    if (!options.write) usageError('baseline requires --write FILE');
    if (options.baseline) usageError('baseline does not take --baseline');
    writeCounts(options.write, countFindings(scanPaths(paths)));
    return 0;
  }

  if (!options.baseline) usageError(`${command} requires --baseline FILE`);

  if (command === 'prune') {
    if (options.write) usageError('prune does not take --write');
    const baseline = loadBaseline(options.baseline);
    const current = countFindings(scanPaths(paths));
    const pruned = {};
    for (const filePath of sortedRules(baseline)) {
      for (const rule of sortedRules(baseline[filePath])) {
        const count = current[filePath]?.[rule] ?? 0;
        if (count > 0) {
          const next = Math.min(count, baseline[filePath][rule]);
          pruned[filePath] ??= {};
          pruned[filePath][rule] = next;
        }
      }
    }
    writeCounts(options.baseline, pruned);
    return 0;
  }

  if (options.write) usageError('check does not take --write');
  const baseline = loadBaseline(options.baseline);
  const findings = scanPaths(paths);
  const current = countFindings(findings);
  const {added, fixed} = compare(current, baseline);

  if (added.length > 0) {
    const allowance = new Map(added.map((entry) => [`${entry.path}\0${entry.rule}`, entry.baseline]));
    const seen = new Map();
    for (const finding of findings) {
      const key = `${finding.path}\0${finding.rule}`;
      if (!allowance.has(key)) continue;
      const used = seen.get(key) ?? 0;
      seen.set(key, used + 1);
      if (used < allowance.get(key)) continue;
      console.log(`${finding.path}:${finding.line}: ${finding.rule}: ${finding.message}`);
    }
  }

  for (const entry of fixed) {
    console.error(`slop-lint: stale baseline entry ${entry.path} ${entry.rule} (baseline ${entry.baseline}, now ${entry.count})`);
  }

  const failOnAdded = added.length > 0 && !options.reportOnly;
  const failOnStale = fixed.length > 0 && !options.passOnUnpruned;
  return failOnAdded || failOnStale ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
