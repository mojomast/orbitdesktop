// Local Chromium gate for the optional Bee tokens section of the Hive Usage
// desk. Serves the real app modules to a same-origin harness and reads back the
// actual DOM; no Orbit, host grant, credential or outbound request is involved.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../apps/rizzstack-hive/', import.meta.url)), out = process.argv[2];
if (!out) throw Error('Pass an evidence directory');
await fs.mkdir(out, { recursive: true });
const { fixtures, fixtureTime } = await import(path.join(app, 'fixtures.js'));

// The additive post-BU2 usage fields, shaped exactly as snapshot.schema.json
// requires them (no extra keys inside those $defs).
const bee = {
  by_role: {
    coordinator: { status: 'known', source: 'bee.usage/v1', requests: 5, input: 2065, output: 615, thinking: 0, total: 2670, cost_usd: null, priced: null, unknown_cost: 5, cache_read: 0 },
    worker: { status: 'known', source: 'rizzstack-rails/usage.observed', requests: 3, input: 500, output: 180, thinking: 40, total: 720, cost_usd: null, priced: null, unknown_cost: 3, cache_read: 0 },
    unknown: { status: 'unknown', source: 'bee.usage/v1', requests: null, input: null, output: null, thinking: null, total: null, cost_usd: null, priced: null, unknown_cost: null, cache_read: 0 },
  },
  bee: {
    status: 'known', source: 'rizzstack-rails/usage.observed', attempts: 3, requests: 3,
    input: 500, output: 180, thinking: 40, total: 720, cost_usd: null, priced: 0, unknown_cost: 3,
    by_model: [{ model: 'deepseek-v4.1-flash', provider: 'go', requests: 2, input: 460, output: 160, thinking: 40, total: 660, cost_usd: null, priced: 0, unknown_cost: 2 }],
    by_repo: [{ repo: 'mojomast/workflow', attempts: 2, requests: 2, input: 300, output: 100, thinking: 20, total: 420 }],
  },
  tokens_per_verified_patch: {
    value: 360, numerator: 720, denominator: 2, unit: 'tokens',
    denominator_rule: 'attempt ids whose verify-results/<attempt_id>.json has ok true and sha matching ^[0-9a-f]{40}$',
    basis: 'worker usage.observed receipts: input+output+thinking tokens', scope: 'all time',
    cost: { status: 'partial', note: 'launcher receipts carry no cost' },
  },
};
const withBee = { ...structuredClone(fixtures.dense), usage: { ...structuredClone(fixtures.dense.usage), ...structuredClone(bee) } };
const bare = structuredClone(fixtures.dense);
for (const key of ['by_role', 'bee', 'tokens_per_verified_patch']) delete bare.usage[key];

const harness = `
import {project} from '/snapshot-adapter.js';
import {createWorkbench} from '/workbench.js';
window.__mount = (snapshot, now, scope) => {
  const root = document.getElementById('desk'), shift = document.createElement('div');
  root.className = ''; root.replaceChildren();
  const workbench = createWorkbench({root, shift, onChoose(){}, onRelease(){}});
  const view = project(snapshot, {now});
  workbench.update(view, {historical: false, demo: true});
  workbench.setScope(scope);
  const section = document.getElementById('bee-tokens');
  const panels = document.querySelector('.hw-panels');
  const html = panels ? panels.innerHTML : '';
  const clone = panels ? panels.cloneNode(true) : null;
  if (clone && clone.querySelector('#bee-tokens')) clone.querySelector('#bee-tokens').remove();
  const rest = clone ? clone.innerHTML : '';
  return {
    usage: (view.sections.find(s => s.id === 'usage') || {}).state || null,
    tokens: view.beeTokens === null ? null : view.beeTokens,
    present: !!section, hidden: section ? section.hidden : null,
    text: section && !section.hidden ? section.innerText : '',
    title: section ? (section.querySelector('.hw-bee-figure')?.title || '') : '',
    html, rest, generated: view.generatedAt,
  };
};
`;
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://local').pathname;
  if (p === '/harness.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(
      '<!doctype html><meta charset="utf-8"><title>bee tokens harness</title>' +
      ['styles.css', 'scene.css', 'workbench.css', 'console.css', 'operations.css', 'triage.css']
        .map(f => `<link rel="stylesheet" href="/${f}">`).join('') +
      '<main class="shell"><div style="width:900px"><div id="desk"></div></div></main>' +
      '<script type="module" src="/harness.js"></script>');
    return;
  }
  if (p === '/harness.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(harness);
    return;
  }
  const name = p === '/' ? 'index.html' : p.slice(1);
  if (!/^(?:[a-zA-Z0-9_-]+\.(?:js|html|css))$/.test(name)) { res.writeHead(404).end(); return; }
  try {
    const bytes = await fs.readFile(path.join(app, name));
    const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(bytes);
  } catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const br = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true, args: ['--disable-dev-shm-usage'] });
const report = { harness: 'hive-bee-tokens', url, checks: [], errors: [], exceptions: [], shots: [] };
const check = (name, pass, observed) => {
  report.checks.push({ name, pass: !!pass, observed });
  if (!pass) console.log('FAIL', name, JSON.stringify(observed));
};
try {
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const offsite = [];
  await ctx.route('**/*', r => {
    if (!r.request().url().startsWith(url + '/')) { offsite.push(r.request().url()); return r.abort(); }
    return r.continue();
  });
  page.setDefaultTimeout(8000);
  await page.goto(url + '/harness.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__mount === 'function');

  const run = (snapshot, scope = 'usage') => page.evaluate(({ s, now, sc }) => window.__mount(s, now, sc), { s: snapshot, now: fixtureTime, sc: scope });

  const present = await run(withBee);
  check('usage section stays live with the additive fields', present.usage === 'live', present.usage);
  check('projection carries the three additive metrics', present.tokens && present.tokens.patch.value === 360 && present.tokens.patch.denominator === 2, present.tokens && present.tokens.patch);
  check('bee section is rendered on the Usage desk', present.present && present.hidden === false, { present: present.present, hidden: present.hidden });
  const shown = present.text.toLowerCase();
  for (const expected of ['tokens per verified patch', '360', '720 tokens ÷ 2 verified patches', 'coordinator', 'worker', 'deepseek-v4.1-flash', '660 tokens'])
    check(`section text shows ${expected}`, shown.includes(expected), shown.includes(expected) ? undefined : present.text.slice(0, 400));
  check('denominator rule and basis are in the figure tooltip', /verify-results/.test(present.title) && /input\+output\+thinking/.test(present.title), present.title);
  const styles = await page.evaluate(() => {
    const sec = document.getElementById('bee-tokens'), figure = sec && sec.querySelector('.hw-bee-figure strong');
    if (!figure) return null;
    const rect = sec.getBoundingClientRect(), cs = getComputedStyle(figure);
    return { width: rect.width, height: rect.height, colour: cs.color, font: cs.fontSize };
  });
  check('rendered section has real layout', !!styles && styles.width > 600 && styles.height > 120, styles);
  check('the metric figure uses the pane brass accent', !!styles && styles.colour === 'rgb(237, 192, 134)' && styles.font === '30px', styles);
  await page.screenshot({ path: path.join(out, 'bee-tokens-usage.png'), fullPage: true });
  report.shots.push('bee-tokens-usage.png');

  const absent = await run(bare);
  check('usage section stays live without the additive fields', absent.usage === 'live', absent.usage);
  check('section is absent from the projection without the fields', absent.tokens === null, absent.tokens);
  check('section is hidden without the fields', absent.hidden === true && absent.text === '', { hidden: absent.hidden, text: absent.text });
  check('the rest of the desk is byte-identical to the with-field render', absent.rest === present.rest,
    { absent: absent.rest.length, present: present.rest.length });
  await page.screenshot({ path: path.join(out, 'bee-tokens-absent.png'), fullPage: true });
  report.shots.push('bee-tokens-absent.png');

  const other = await run(withBee, 'job');
  check('section is not shown on an unrelated desk', other.hidden === true, other.hidden);

  // A producer that stops sending the fields and later resumes must not leave a
  // headless or duplicated section behind.
  await run(bare);
  const again = await run(withBee);
  check('the section returns intact after a snapshot without the fields', again.hidden === false &&
    /Bee tokens/i.test(again.text) && /360/.test(again.text) && again.text.toLowerCase().includes('deepseek-v4.1-flash'), again.text.slice(0, 200));

  check('no page or console errors', errors.length === 0, errors);

  // The shipped document, unchanged: a pre-BU2 demo snapshot must render the
  // Usage desk exactly as before with the section hidden and no errors.
  const live = await ctx.newPage();
  const liveErrors = [];
  live.on('pageerror', e => liveErrors.push(String(e)));
  live.on('console', m => { if (m.type() === 'error') liveErrors.push('console: ' + m.text()); });
  await live.goto(url + '/index.html?demo=dense', { waitUntil: 'load' });
  await live.getByRole('navigation', { name: 'Work surfaces' }).getByRole('button', { name: 'Work register', exact: true }).click();
  await live.getByRole('tab', { name: 'Usage', exact: true }).click();
  await live.waitForSelector('#hw-panel-usage .hw-list');
  const demo = await live.evaluate(() => {
    const sec = document.getElementById('bee-tokens');
    const panel = document.getElementById('hw-panel-usage');
    return { hidden: sec ? sec.hidden : null, display: sec ? getComputedStyle(sec).display : null,
      rows: panel ? panel.querySelectorAll('.hw-list > li').length : 0, panel: panel ? panel.innerText : '' };
  });
  check('the demo document hides the section entirely', demo.hidden === true && demo.display === 'none', { hidden: demo.hidden, display: demo.display });
  check('the demo Usage desk still lists its records', demo.rows > 0 && /usage totals/i.test(demo.panel), { rows: demo.rows });
  check('the shipped demo page has no console errors', liveErrors.length === 0, liveErrors);
  await live.screenshot({ path: path.join(out, 'bee-tokens-demo-app.png'), fullPage: true });
  report.shots.push('bee-tokens-demo-app.png');
  check('no offsite requests', offsite.length === 0, offsite);
} catch (error) {
  report.exceptions.push(String(error.stack || error));
  console.error(error);
} finally {
  await br.close();
  server.close();
  await fs.writeFile(path.join(out, 'hive-bee-tokens.json'), JSON.stringify(report, null, 2));
}
const failed = report.checks.filter(c => !c.pass).length + report.exceptions.length;
console.log(`${report.checks.length} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
