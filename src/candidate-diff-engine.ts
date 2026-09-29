import {createTwoFilesPatch, diffArrays, diffWordsWithSpace} from 'diff';
import type {CalculatedDiff, CandidateDiffFile, DiffLine, DiffRow, DiffToken} from './candidate-diff-types';

const LINE_TIMEOUT = 750;
const MAX_EDITS = 1200;
const TOKEN_LIMIT = 2048;

// A final newline terminates the previous line; it does not create an empty line.
function lines(text: string): string[] {
  if (!text) return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

function rawFallback(oldPath: string, newPath: string, before: string, after: string): string {
  // A complete replacement is a valid exact patch even if the bounded Myers
  // search could not find a minimal edit script.
  const old = lines(before), next = lines(after);
  const body: string[] = [];
  function append(prefix: string, content: string[], final: boolean) {
    if (!content.length) return;
    for (let i = 0; i < content.length; i++) {
      body.push(prefix + content[i]);
      if (i === content.length - 1 && !final) body.push('\\ No newline at end of file');
    }
  }
  append('-', old, before.endsWith('\n'));
  append('+', next, after.endsWith('\n'));
  return `--- ${oldPath}\n+++ ${newPath}\n@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@\n${body.join('\n')}\n`;
}

function emphasize(old: DiffLine, next: DiffLine): void {
  if (old.text.length > TOKEN_LIMIT || next.text.length > TOKEN_LIMIT) return;
  const changes = diffWordsWithSpace(old.text, next.text, {timeout: 35, maxEditLength: 120});
  if (!changes) return;
  const oldTokens: DiffToken[] = [], newTokens: DiffToken[] = [];
  for (const change of changes) {
    const token = {text: change.value, changed: !!(change.added || change.removed)};
    if (!change.added) oldTokens.push(token);
    if (!change.removed) newTokens.push(token);
  }
  old.tokens = oldTokens;
  next.tokens = newTokens;
}

export function calculateDiff(file: CandidateDiffFile, options: {ignoreWhitespace?: boolean} = {}): CalculatedDiff {
  if (!file.text_available) return {rows: [], hunks: [], additions: 0, deletions: 0, raw: '', limited: true,
    notice: `Text comparison unavailable (${file.reason ?? 'historical source unavailable'}); no line statistics were calculated.`};
  const before = file.old_text ?? '', after = file.new_text ?? '';
  const old = lines(before), next = lines(after);
  const oldPath = file.old_hash === null ? '/dev/null' : `a/${file.path}`;
  const newPath = file.new_hash === null ? '/dev/null' : `b/${file.path}`;
  // Raw never receives the presentation-only ignoreWhitespace option.
  const patch = createTwoFilesPatch(oldPath, newPath, before, after, undefined, undefined,
    {context: 3, timeout: LINE_TIMEOUT, maxEditLength: MAX_EDITS});
  const rawLimited = patch === undefined;
  const raw = patch ?? rawFallback(oldPath, newPath, before, after);
  const normalize = (line: string) => options.ignoreWhitespace ? line.replace(/\s/gu, '') : line;
  const oldUnits = old.map((text, index) => ({text, terminated: index < old.length - 1 || before.endsWith('\n')}));
  const newUnits = next.map((text, index) => ({text, terminated: index < next.length - 1 || after.endsWith('\n')}));
  const changes = diffArrays(oldUnits, newUnits, {comparator: (a, b) => normalize(a.text) === normalize(b.text) && a.terminated === b.terminated,
    timeout: LINE_TIMEOUT, maxEditLength: MAX_EDITS});
  const rows: DiffRow[] = [];
  let oldIndex = 0, newIndex = 0;
  const makeOld = (): DiffLine => ({number: ++oldIndex, text: old[oldIndex - 1]});
  const makeNew = (): DiffLine => ({number: ++newIndex, text: next[newIndex - 1]});
  if (!changes) {
    // Never represent a timed-out comparison as an unchanged file.
    while (oldIndex < old.length) rows.push({kind: 'delete', old: makeOld()});
    while (newIndex < next.length) rows.push({kind: 'add', new: makeNew()});
  } else {
    for (let i = 0; i < changes.length;) {
      const part = changes[i];
      if (!part.added && !part.removed) {
        for (let j = 0; j < part.count; j++) rows.push({kind: 'context', old: makeOld(), new: makeNew()});
        i++;
        continue;
      }
      let removed = 0, added = 0;
      while (i < changes.length && (changes[i].added || changes[i].removed)) {
        if (changes[i].removed) removed += changes[i].count;
        if (changes[i].added) added += changes[i].count;
        i++;
      }
      const paired = Math.min(removed, added);
      for (let j = 0; j < paired; j++) {
        const left = makeOld(), right = makeNew();
        emphasize(left, right);
        rows.push({kind: 'modify', old: left, new: right});
      }
      for (let j = paired; j < removed; j++) rows.push({kind: 'delete', old: makeOld()});
      for (let j = paired; j < added; j++) rows.push({kind: 'add', new: makeNew()});
    }
  }
  const hunks: CalculatedDiff['hunks'] = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].kind === 'context') {index++; continue;}
    const start = index;
    while (index < rows.length && rows[index].kind !== 'context') index++;
    hunks.push({start, end: index});
  }
  // Line termination remains significant even in whitespace presentation mode.
  const limited = rawLimited || !changes;
  return {rows, hunks, additions: rows.filter(row => row.kind === 'add' || row.kind === 'modify').length,
    deletions: rows.filter(row => row.kind === 'delete' || row.kind === 'modify').length,
    raw, ...(limited ? {limited: true, notice: 'Diff complexity limit reached; showing a complete replacement where needed.'} : {})};
}
