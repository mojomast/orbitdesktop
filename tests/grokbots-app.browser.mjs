// Headless browser checks for the Grok Bots app features.
// Run: node --experimental-strip-types --test tests/grokbots-app.browser.mjs
// (ORBIT_TEST_CHROMIUM may point at a Chrome/Chromium binary.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture, AGENT, AGENT2 } from './grokbots-browser-fixture.mjs';

import fs from 'node:fs';
const executablePath = process.env.ORBIT_TEST_CHROMIUM || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : chromium.executablePath());
const transcript = [
  { id: 'u1', kind: 'message', role: 'user', content: 'Write a plan', timestampMs: 1000 },
  { id: 't1', kind: 'tool-call', name: 'read_file', status: 'completed', summary: 'docs/PLAN.md', timestampMs: 1500, completedAt: 1900 },
  { id: 't2e', kind: 'tool-call', toolCallId: 't2', name: 'run_tests', status: 'failed', summary: 'npm test', timestampMs: 1600 },
  { id: 't2r', kind: 'tool-result', toolCallId: 't2', name: 'run_tests', output: '3 failing', isError: true, timestampMs: 1800 },
  { id: 'a1', kind: 'message', role: 'assistant', content: '# Plan\n\nStep one.\n\n```js\nconsole.log(1)\n```', timestampMs: 2000 },
];
let fx, browser;
async function open(hash = '') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${fx.origin}/#${fx.appUrl}${hash}`);
  const app = page.frameLocator('#app');
  return { page, app, errors, context };
}
test.before(async () => { fx = await startFixture({ transcript }); browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] }); });
test.after(async () => { await browser?.close(); await fx?.close(); });

test('copy message, copy code and create a document from a reply', async () => {
  const { page, app, errors, context } = await open(`&p=grok&a=${AGENT}`);
  await app.locator('#msgs .m.assistant').first().waitFor();
  const reply = app.locator('#msgs .m.assistant').first();
  await reply.hover();
  await reply.getByRole('button', { name: 'Copy', exact: true }).first().click();
  await app.locator('#toast', { hasText: /Copied|Copy failed/ }).waitFor();
  await reply.locator('pre .cc').click();
  await reply.hover();
  await reply.getByRole('button', { name: '📄 Document' }).click();
  await app.locator('#toast', { hasText: 'Document draft created' }).waitFor();
  const ops = await page.evaluate(() => window.__ops);
  const doc = ops.find(o => o.op === 'document');
  assert.match(doc.text, /^# Plan/);
  assert.match(doc.title, /Plan/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('drafts survive switching conversations and reloading', async () => {
  const { page, app, errors, context } = await open(`&p=grok&a=${AGENT}`);
  await app.locator('#msgs .m').first().waitFor();
  await app.locator('#in').fill('draft for stub bot');
  await page.waitForTimeout(1200);
  await app.locator('.bot', { hasText: 'Second Bot' }).click();
  await page.waitForTimeout(700);
  assert.equal(await app.locator('#in').inputValue(), '');
  await app.locator('#in').fill('draft for second');
  await page.waitForTimeout(1200);
  await app.locator('.bot', { hasText: 'Stub Bot' }).click();
  await page.waitForFunction(() => true);
  await page.waitForTimeout(700);
  assert.equal(await app.locator('#in').inputValue(), 'draft for stub bot');
  await page.reload();
  await page.frameLocator('#app').locator('#msgs .m').first().waitFor();
  await page.waitForTimeout(1200);
  assert.equal(await page.frameLocator('#app').locator('#in').inputValue(), 'draft for stub bot');
  assert.deepEqual(errors, []);
  await context.close();
});

test('sending while the agent works queues; queued messages can be edited, reordered and removed, then drain when idle', async () => {
  fx.state.running = true;
  const { page, app, errors, context } = await open(`&p=grok&a=${AGENT}`);
  await app.locator('#msgs .m').first().waitFor();
  await page.waitForTimeout(1500);
  for (const t of ['first queued', 'second queued', 'third queued']) { await app.locator('#in').fill(t); await app.locator('#in').press('Enter'); }
  await app.locator('#queue .qi').nth(2).waitFor();
  assert.equal(await app.locator('#send').textContent(), 'Queue');
  // edit the second
  await app.locator('#queue .qi').nth(1).getByRole('button', { name: 'Edit' }).click();
  await app.locator('#queue .qi textarea').fill('second (edited)');
  await app.locator('#queue .qi').getByRole('button', { name: 'Save' }).click();
  // move the third up, remove the first
  await app.locator('#queue .qi').nth(2).getByRole('button', { name: '↑' }).click();
  await app.locator('#queue .qi').nth(0).getByRole('button', { name: '✕' }).click();
  const texts = await app.locator('#queue .qi .qt').allTextContents();
  assert.deepEqual(texts, ['1. third queued', '2. second (edited)']);
  assert.equal(fx.seen.filter(s => s.url === '/api/sendPrompt').length, 0);
  // reload keeps the queue
  await page.reload();
  const app2 = page.frameLocator('#app');
  await app2.locator('#queue .qi').nth(1).waitFor();
  // agent goes idle: the queue drains in order
  fx.state.running = false;
  await page.waitForFunction(() => true);
  for (let i = 0; i < 40 && fx.seen.filter(s => s.url === '/api/sendPrompt').length < 2; i++) await page.waitForTimeout(500);
  const prompts = fx.seen.filter(s => s.url === '/api/sendPrompt').map(s => s.body.prompt);
  assert.deepEqual(prompts, ['third queued', 'second (edited)']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('attach files with the picker; the sent message carries their host paths', async () => {
  const { page, app, errors, context } = await open(`&p=grok&a=${AGENT2}`);
  await page.waitForTimeout(1500);
  await app.locator('input[type=file]').setInputFiles([{ name: 'todo.txt', mimeType: 'text/plain', buffer: Buffer.from('buy milk') }, { name: 'pic.png', mimeType: 'image/png', buffer: Buffer.alloc(500, 1) }]);
  await app.locator('#atts .att', { hasText: 'pic.png · 500 B' }).waitFor();
  await app.locator('#atts .att', { hasText: 'todo.txt · 8 B' }).waitFor();
  await app.locator('#in').fill('please review');
  const before = fx.seen.filter(s => s.url === '/api/sendPrompt').length;
  await app.locator('#send').click();
  for (let i = 0; i < 20 && fx.seen.filter(s => s.url === '/api/sendPrompt').length === before; i++) await page.waitForTimeout(250);
  const prompt = fx.seen.filter(s => s.url === '/api/sendPrompt').at(-1).body.prompt;
  assert.match(prompt, /^please review\n\n\[Attached files/);
  assert.match(prompt, /grokbots-uploads\/[0-9a-f-]{36}\/todo\.txt/);
  assert.match(prompt, /--- todo\.txt ---\nbuy milk/);
  assert.equal(await app.locator('#atts .att').count(), 0);
  await app.locator('#msgs .matt', { hasText: 'todo.txt, pic.png' }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test('tool calls render as inline cards between messages, and the activity panel has filter tools', async () => {
  const { page, app, errors, context } = await open(`&p=grok&a=${AGENT}`);
  const group = app.locator('details.tools').first();
  await group.waitFor();
  assert.match(await group.locator('summary').first().textContent(), /2 tool calls: read_file, run_tests · ⚠ 1 failed/);
  // anchored after the user message, before the reply
  assert.equal(await app.locator('#msgs > *').evaluateAll(els => els.map(e => e.className.split(' ')[0] || e.tagName).join(',')), 'm,tools,m');
  await group.locator('summary').first().click();
  const failed = app.locator('.tcard.error');
  await failed.locator('summary').click();
  assert.match(await failed.textContent(), /npm test[\s\S]*3 failing/);
  assert.match(await app.locator('.tcard.done .tm').textContent(), /done · 400 ms/);
  // hide/show tool cards
  await app.locator('#toolsTog').click();
  assert.equal(await app.locator('details.tools').count(), 0);
  await app.locator('#toolsTog').click();
  assert.equal(await app.locator('details.tools').count(), 1);
  // activity toolbar exists
  await app.locator('#actbtn').click();
  await app.locator('#actq').waitFor();
  await page.screenshot({ path: process.env.GB_SHOTS ? process.env.GB_SHOTS + '/05-tool-cards.png' : '/tmp/gb-05.png' });
  assert.deepEqual(errors, []);
  await context.close();
});

test('conversation library searches bots and Hermes sessions, opens here or in a new window, and exports', async () => {
  const { page, app, errors, context } = await open(`&p=grok&a=${AGENT2}`);
  await app.locator('#libbtn').click();
  await app.locator('#librows .lr', { hasText: 'Hermes planning chat' }).waitFor();
  assert.ok(await app.locator('#librows .lr', { hasText: 'Stub Bot' }).count() >= 1);
  await app.locator('#libq').fill('planning');
  assert.equal(await app.locator('#librows .lr').count(), 1);
  await page.screenshot({ path: process.env.GB_SHOTS ? process.env.GB_SHOTS + '/06-library.png' : '/tmp/gb-06.png' });
  // new window goes through the host bridge
  await app.locator('#librows .lr button', { hasText: 'New window' }).click();
  await page.waitForFunction(() => window.__ops.some(o => o.op === 'open'));
  const op = await page.evaluate(() => window.__ops.find(o => o.op === 'open'));
  assert.deepEqual([op.profile, op.agent, op.session, op.newWindow], ['default', 'default', 'sess_1', true]);
  await app.locator('#lib.on').waitFor({ state: 'detached' }).catch(() => {});
  assert.equal(await app.locator('#lib.on').count(), 0); // the dialog closes once Orbit opened the window
  // export markdown of Stub Bot, which has messages and tool calls
  await app.locator('#libbtn').click();
  await app.locator('#libq').fill('Stub Bot');
  const [dl] = await Promise.all([page.waitForEvent('download'), app.locator('#librows .lr', { hasText: 'Stub Bot' }).first().locator('button', { hasText: '.md' }).click()]);
  const md = fs.readFileSync(await dl.path(), 'utf8');
  assert.equal(dl.suggestedFilename(), 'Stub-Bot.md');
  assert.match(md, /^# Stub Bot/);
  assert.match(md, /## You[^\n]*\n\nWrite a plan/);
  assert.match(md, /🔧 `run_tests` — error/);
  const [dj] = await Promise.all([page.waitForEvent('download'), app.locator('#librows .lr', { hasText: 'Stub Bot' }).first().locator('button', { hasText: '.json' }).click()]);
  const j = JSON.parse(fs.readFileSync(await dj.path(), 'utf8'));
  assert.equal(j.messages.length, 2); assert.equal(j.tools.length, 2);
  // open here
  await app.locator('#librows .lr', { hasText: 'Stub Bot' }).first().locator('button', { hasText: 'Open' }).first().click();
  await app.locator('#title', { hasText: 'Stub Bot' }).waitFor();
  assert.equal(await app.locator('#lib.on').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
