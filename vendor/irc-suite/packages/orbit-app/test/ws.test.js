import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  acceptValue, makeKey, encodeFrame, createFrameParser, createServerConnection, createClient, OPCODES, WEBSOCKET_GUID,
} from '../src/ws.js';

class StubSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
    this.ended = false;
  }

  write(chunk) {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }

  end() { this.ended = true; }

  destroy() { this.destroyed = true; }

  get bytes() { return Buffer.concat(this.writes); }

  readFrames() {
    const frames = [];
    createFrameParser((frame) => frames.push(frame)).push(this.bytes);
    return frames;
  }
}

test('Sec-WebSocket-Accept matches the RFC 6455 example', () => {
  assert.equal(acceptValue('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.equal(WEBSOCKET_GUID, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  assert.ok(makeKey().length >= 20);
  assert.notEqual(makeKey(), makeKey());
});

test('frame encoding covers the 7, 16 and 64 bit length forms', () => {
  const short = encodeFrame('hi');
  assert.deepEqual([...short.subarray(0, 2)], [0x81, 2]);
  assert.equal(short.subarray(2).toString('utf8'), 'hi');

  const medium = encodeFrame('x'.repeat(200));
  assert.equal(medium[0], 0x81);
  assert.equal(medium[1], 126);
  assert.equal(medium.readUInt16BE(2), 200);
  assert.equal(medium.length, 4 + 200);

  const large = encodeFrame('y'.repeat(70000));
  assert.equal(large[1], 127);
  assert.equal(Number(large.readBigUInt64BE(2)), 70000);
  assert.equal(large.length, 10 + 70000);
});

test('a masked client frame is accepted and unmasked', () => {
  const frames = [];
  createFrameParser((frame) => frames.push(frame)).push(encodeFrame('from the browser', { mask: true }));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, OPCODES.text);
  assert.equal(frames[0].payload.toString('utf8'), 'from the browser');
});

test('the parser reassembles frames split across chunks and fragmented messages', () => {
  const frames = [];
  const parser = createFrameParser((frame) => frames.push(frame));
  const whole = encodeFrame('hello world');
  parser.push(whole.subarray(0, 4));
  assert.equal(frames.length, 0, 'emitted before the frame was complete');
  parser.push(whole.subarray(4));
  assert.equal(frames[0].payload.toString('utf8'), 'hello world');

  const first = encodeFrame('one ', { fin: false });
  const second = encodeFrame('two', { opcode: OPCODES.continuation });
  parser.push(Buffer.concat([first, second]));
  assert.equal(frames[1].payload.toString('utf8'), 'one two');
  assert.equal(parser.pending, 0);
});

test('server connections dispatch text, answer pings and close cleanly', () => {
  const socket = new StubSocket();
  const received = [];
  const closes = [];
  const conn = createServerConnection(socket, {
    onText: (text) => received.push(text),
    onClose: (info) => closes.push(info),
  });

  assert.equal(conn.open, true);
  conn.sendJson({ type: 'hello' });
  socket.emit('data', encodeFrame('{"cmd":"say","text":"hi"}', { mask: true }));
  assert.deepEqual(received, ['{"cmd":"say","text":"hi"}']);

  const sent = socket.readFrames();
  assert.equal(sent[0].opcode, OPCODES.text);
  assert.deepEqual(JSON.parse(sent[0].payload.toString('utf8')), { type: 'hello' });

  socket.emit('data', encodeFrame('ping-payload', { opcode: OPCODES.ping, mask: true }));
  const pong = socket.readFrames().find((f) => f.opcode === OPCODES.pong);
  assert.equal(pong.payload.toString('utf8'), 'ping-payload');

  socket.emit('data', encodeFrame(Buffer.from([0x03, 0xe8]), { opcode: OPCODES.close, mask: true }));
  assert.equal(closes.length, 1);
  assert.equal(closes[0].code, 1000);
  assert.equal(conn.open, false);

  const socket2 = new StubSocket();
  const conn2 = createServerConnection(socket2, {});
  conn2.close();
  assert.ok(socket2.ended, 'close() did not end the socket');
  assert.ok(socket2.bytes.length > 0, 'close() did not send a close frame');
});

test('bytes that arrived with the upgrade request are still parsed', () => {
  const socket = new StubSocket();
  const received = [];
  const head = encodeFrame('early-bird', { mask: true });
  const conn = createServerConnection(socket, { head, onText: (text) => received.push(text) });
  assert.deepEqual(received, ['early-bird']);
  conn.sendText('ok');
  assert.equal(socket.readFrames()[0].payload.toString('utf8'), 'ok');
});

test('createClient completes a handshake against a real server and rejects a bad one', async (t) => {
  const good = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\r\n\r\n')) return;
      const match = /Sec-WebSocket-Key:\s*(.+)/i.exec(buffer);
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptValue(match[1].trim())}`, '', ''].join('\r\n'));
      buffer = '';
      setTimeout(() => socket.write(encodeFrame('{"type":"welcome"}')), 10);
      setTimeout(() => socket.write(encodeFrame('hello', { opcode: OPCODES.ping })), 20);
    });
  });
  await new Promise((resolve) => good.listen(0, '127.0.0.1', resolve));
  const goodPort = good.address().port;

  const rejecting = net.createServer((socket) => {
    socket.on('data', () => socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  });
  await new Promise((resolve) => rejecting.listen(0, '127.0.0.1', resolve));
  const rejectPort = rejecting.address().port;

  t.after(async () => {
    good.close();
    rejecting.close();
  });

  const client = await createClient(`ws://127.0.0.1:${goodPort}/ws`);
  assert.match(client.handshake.status, /101/);
  assert.equal(client.handshake.headers.upgrade.toLowerCase(), 'websocket');
  const welcome = await client.waitFor((m) => m.type === 'welcome');
  assert.equal(welcome.type, 'welcome');
  client.close();

  await assert.rejects(() => createClient(`ws://127.0.0.1:${rejectPort}/ws`), /handshake failed|403/);
});

test('an oversized declared length is treated as a protocol error, not a crash', () => {
  const socket = new StubSocket();
  const errors = [];
  createServerConnection(socket, { onError: (err) => errors.push(err) });
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(0xffffffffffffffffn, 2);
  socket.emit('data', header);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /too large/);
});
