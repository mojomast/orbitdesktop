import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrate, compactTranscript, contextWindowFor, dateGroup, estimateTokens, formatTokens,
  isToolOutput, measureContext, meterLabel, meterLevel, shouldAutoCompact, smallerWindow,
} from '../src/context-budget.ts';

test('token estimates use chars/4 for prose and chars/3 for code, then calibrate', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('{"a":1}'), Math.ceil('{"a":1}'.length / 3));
  assert.equal(calibrate(100, 150), 1.5);
  assert.equal(calibrate(0, 10), null);
  assert.equal(calibrate(10, 1000), 4);
  const measured = measureContext({ messages: [{ role: 'user', text: 'abcd' }], reported: 8 });
  assert.equal(measured.source, 'reported');
  assert.equal(measured.used, 8);
  assert.equal(meterLevel(50, 100), 'ok');
  assert.equal(meterLevel(60, 100), 'warn');
  assert.equal(meterLevel(80, 100), 'hot');
  assert.equal(shouldAutoCompact(80, 100), true);
  assert.equal(meterLabel({ ...measured, source: 'estimated', used: 4 }, 128000), '4 / 128k · ≈ estimated');
  assert.equal(formatTokens(100), '100');
});

test('compaction prunes tool output and keeps the required summary fields', () => {
  const early = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `turn ${index}` }));
  const messages = [
    { role: 'user', text: 'Ship the context meter.\nDecided to keep Hermes compression because it already uses reported usage.\nPlan: show the meter.\nTODO: fork old chats.\nFile src/agent-chat.ts\n$ npm test\nError: boom\nMust keep session orbit-1234.' },
    { role: 'tool', text: 'tool result\n' + 'x'.repeat(2000) },
    { role: 'assistant', text: JSON.stringify({ raw: true, blob: 'y'.repeat(500) }) },
    ...early,
  ];
  const result = compactTranscript(messages, 10);
  assert.equal(result.pruned_tools, 2);
  assert.equal(result.raw.length, messages.length);
  assert.match(result.summary, /Summary of \d+ earlier messages/);
  assert.match(result.summary, /Goal: Ship the context meter/);
  assert.match(result.summary, /Decisions:.*because/);
  assert.match(result.summary, /Plan:.*meter/);
  assert.match(result.summary, /Open TODOs:.*fork/);
  assert.match(result.summary, /src\/agent-chat\.ts/);
  assert.match(result.summary, /Commands:.*npm test/);
  assert.match(result.summary, /Constraints:.*orbit-1234/);
  assert.equal(result.view[0].role, 'user');
  assert.match(result.view[0].text, /Ship the context meter/);
  assert.match(result.view[1].text, /^Summary of /);
  assert.ok(result.view.some(message => message.text.startsWith('Summary of ')));
  assert.equal(result.view.filter(message => message.text.startsWith('turn')).length <= 20, true);
  assert.equal(result.view.some(message => message.text.includes('tool result')), false);
});

test('windows, smaller-window warning, and date groups', () => {
  assert.equal(contextWindowFor('grok-4', 'grok'), 256000);
  assert.equal(contextWindowFor('window-100', 'grok'), 100);
  assert.equal(contextWindowFor('gateway model', 'hermes'), 128000);
  assert.equal(smallerWindow(200, 100), true);
  assert.equal(smallerWindow(50, 100), false);
  const now = new Date('2026-10-13T15:00:00Z');
  assert.equal(dateGroup('2026-10-13T01:00:00Z', now), 'Today');
  assert.equal(dateGroup('2026-10-12T20:00:00Z', now), 'Yesterday');
  assert.equal(dateGroup('2026-10-08T12:00:00Z', now), 'Previous 7 days');
  assert.equal(dateGroup('2026-01-01T00:00:00Z', now), 'Older');
  assert.equal(dateGroup('', now), 'Older');
});
