// Headless browser checks for the Grok Bots app features.
// Run: node --experimental-strip-types --test tests/grokbots-app.browser.mjs
// (ORBIT_TEST_CHROMIUM may point at a Chrome/Chromium binary.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture, AGENT } from './grokbots-browser-fixture.mjs';

import fs from 'node:fs';
const executablePath = process.env.ORBIT_TEST_CHROMIUM || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : chromium.executablePath());
const transcript = [
  { id: 'u1', kind: 'message', role: 'user', content: 'Write a plan', timestampMs: 1000 },
  { id: 't1', kind: 'tool-call', name: 'read_file', status: 'completed', summary: 'docs/PLAN.md', timestampMs: 1500, completedAt: 1900 },
  { id: 'a1', kind: 'message', role: 'assistant', content: '# Plan\n\nStep one.\n\n```js\nconsole.log(1)\n```', timestampMs: 2000 },
];
let fx, browser;
async function open(hash = '') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
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
