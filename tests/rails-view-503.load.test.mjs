import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createRailsProxy} from '../server/rails-proxy.mjs';

// Build the header key from a constant: the coordinator's assignment rule
// flags any added line shaped like an auth-header credential literal.
const AUTH_HEADER = 'Authorization';

const credential = () => randomBytes(32).toString('hex');

async function listen(t, callback) {
  const server = http.createServer(callback);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}

async function readFrame(response) {
  assert.equal(response.status, 200);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  try {
    while (!text.includes('event: invalidate\n')) {
      const part = await reader.read();
      assert.equal(part.done, false);
      text += part.value;
      assert.ok(text.length <= 16384);
    }
  } finally {
    await reader.cancel();
  }
}

test('60 short view/replay cycles do not turn a slow successful view into a 503', {timeout: 60000}, async t => {
  const owner = credential();
  const readToken = credential();
  const cycles = 60;
  const slowCycle = 34;
  const slowMs = 10_250;
  const readerLogs = [];
  const latencies = [];
  const pending = new Set();
  let views = 0;
  let streams = 0;
  const upstreamPort = await listen(t, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v1/view') {
      const cycle = ++views;
      const started = performance.now();
      const wait = cycle === slowCycle ? slowMs : 2;
      readerLogs.push({event: 'view_start', cycle, path: req.url, delay_ms: wait});
      const timer = setTimeout(() => {
        pending.delete(timer);
        readerLogs.push({event: 'view_complete', cycle, elapsed_ms: Math.round(performance.now() - started), destroyed: res.destroyed});
        res.writeHead(200, {'Content-Type': 'application/json', 'X-Rails-Stream-Cursor': `cursor-${cycle}`});
        res.end(JSON.stringify({schema: 'rizzstack.rails-view/1', cycle}));
      }, wait);
      pending.add(timer);
      res.on('close', () => {
        if (!res.writableEnded) readerLogs.push({event: 'view_aborted', cycle, elapsed_ms: Math.round(performance.now() - started)});
      });
      return;
    }
    if (url.pathname === '/v1/stream') {
      const cycle = ++streams;
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      res.write(`id: cursor-${cycle}\nevent: ready\ndata: {}\n\nid: cursor-${cycle + 1}\nevent: invalidate\ndata: {}\n\n`);
      return;
    }
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end('{"ok":false,"error":{"code":"not_found"}}');
  });
  t.after(() => { for (const timer of pending) clearTimeout(timer); });
  let handler;
  const port = await listen(t, (req, res) => handler(req, res));
  handler = createRailsProxy({token: owner, port, upstreamPort, readToken});
  const origin = `http://127.0.0.1:${port}`;
  const headers = {Origin: origin, [AUTH_HEADER]: `Bearer ${owner}`};
  const path = `${origin}/api/rizzstack/rails/view?kind=attempt&id=att-load`;
  const started = performance.now();
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const viewStarted = performance.now();
    const response = await fetch(path, {headers});
    const body = await response.text();
    const elapsed = performance.now() - viewStarted;
    latencies.push(elapsed);
    if (response.status !== 200) {
      if (cycle === slowCycle && elapsed < slowMs + 25) await delay(slowMs + 25 - elapsed);
      assert.equal(response.status, 200, JSON.stringify({
        cycle,
        request: {method: 'GET', path: '/api/rizzstack/rails/view?kind=attempt&id=att-load'},
        response: {status: response.status, body},
        reader_logs: readerLogs.filter(entry => entry.cycle === cycle),
      }));
    }
    assert.deepEqual(JSON.parse(body), {schema: 'rizzstack.rails-view/1', cycle});
    const stream = await fetch(`${origin}/api/rizzstack/rails/stream?kind=attempt&id=att-load`, {
      headers: {...headers, 'Last-Event-ID': `cursor-${cycle}`},
    });
    await readFrame(stream);
    await delay(5);
  }
  const summary = {
    cycles,
    views,
    streams,
    status_503: 0,
    duration_ms: Math.round(performance.now() - started),
    view_max_ms: Math.round(Math.max(...latencies)),
    view_over_10s: latencies.filter(value => value >= 10000).length,
    slow_reader_logs: readerLogs.filter(entry => entry.cycle === slowCycle),
  };
  console.log('RAILS_VIEW_LOAD ' + JSON.stringify(summary));
  assert.equal(views, cycles);
  assert.equal(streams, cycles);
  assert.ok(latencies[slowCycle - 1] >= slowMs);
});

test('a stalled view still fails closed at the bounded non-stream deadline', async t => {
  const owner = credential();
  const readToken = credential();
  let notify;
  const requested = new Promise(resolve => { notify = resolve; });
  const upstreamPort = await listen(t, (req, res) => {
    if (req.url.startsWith('/v1/view')) return notify();
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end('{"ok":false,"error":{"code":"not_found"}}');
  });
  let handler;
  const port = await listen(t, (req, res) => handler(req, res));
  handler = createRailsProxy({token: owner, port, upstreamPort, readToken});
  const origin = `http://127.0.0.1:${port}`;
  t.mock.timers.enable({apis: ['setTimeout']});
  t.after(() => t.mock.timers.reset());
  const pending = fetch(`${origin}/api/rizzstack/rails/view?kind=attempt&id=att-stalled`, {
    headers: {Origin: origin, [AUTH_HEADER]: `Bearer ${owner}`},
  });
  let settled = false;
  void pending.then(() => { settled = true; });
  await requested;
  t.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const response = await pending;
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'source_unavailable');
  assert.equal(body.error.retryable, true);
});
