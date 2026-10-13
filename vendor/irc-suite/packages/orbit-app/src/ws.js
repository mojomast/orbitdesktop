// Minimal RFC 6455 websocket framing: no dependencies, usable by the server,
// by tests, and by anyone wanting a small browser-less websocket client.
import crypto from 'node:crypto';
import net from 'node:net';

export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };
export const CLOSE_NORMAL = 1000;

/** Sec-WebSocket-Accept for a given Sec-WebSocket-Key. */
export function acceptValue(key) {
  return crypto.createHash('sha1').update(String(key) + WEBSOCKET_GUID).digest('base64');
}

/** A fresh 16-byte base64 Sec-WebSocket-Key. */
export function makeKey() {
  return crypto.randomBytes(16).toString('base64');
}

/** Encode one frame (server frames are unmasked, client frames must be masked). */
export function encodeFrame(payload, { opcode = OPCODES.text, fin = true, mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  const head = [((fin ? 0x80 : 0x00) | (opcode & 0x0f))];
  const lenFlag = mask ? 0x80 : 0x00;
  if (data.length < 126) {
    head.push(lenFlag | data.length);
  } else if (data.length < 65536) {
    head.push(lenFlag | 126, (data.length >> 8) & 0xff, data.length & 0xff);
  } else {
    const ext = Buffer.alloc(8);
    ext.writeBigUInt64BE(BigInt(data.length));
    head.push(lenFlag | 127, ...ext);
  }
  const header = Buffer.from(head);
  if (!mask) return Buffer.concat([header, data]);
  const key = crypto.randomBytes(4);
  const body = Buffer.from(data);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
  return Buffer.concat([header, key, body]);
}

export function encodeCloseFrame(code = CLOSE_NORMAL, reason = '') {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2, 'utf8');
  return encodeFrame(payload, { opcode: OPCODES.close });
}

/**
 * Incremental frame parser. Calls onFrame({ opcode, payload, fin }) for complete
 * messages (continuation frames are reassembled) and onProtocolError on garbage.
 */
export function createFrameParser(onFrame, { onProtocolError } = {}) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = null;

  function parse() {
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < offset + 2) return;
        length = buf.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset);
        if (big > 0x7fffffffn) { onProtocolError?.(new Error('frame too large')); buf = Buffer.alloc(0); return; }
        length = Number(big);
        offset += 8;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + length) return;
      const payload = Buffer.from(buf.subarray(offset, offset + length));
      buf = buf.subarray(offset + length);
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];

      if (opcode === OPCODES.continuation) {
        fragments.push(payload);
        if (fin) {
          const data = Buffer.concat(fragments);
          const op = fragmentOpcode ?? OPCODES.text;
          fragments = [];
          fragmentOpcode = null;
          onFrame({ opcode: op, payload: data, fin: true });
        }
        continue;
      }
      if (!fin) {
        fragmentOpcode = opcode;
        fragments = [payload];
        continue;
      }
      onFrame({ opcode, payload, fin: true });
    }
  }

  return {
    push(chunk) {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      parse();
      return this;
    },
    get pending() {
      return buf.length;
    },
  };
}

/**
 * Wrap an established server-side socket (already past the upgrade) as a
 * websocket connection. `socket` may be a net.Socket or a duplex-like stub with
 * write/end/destroy.
 */
export function createServerConnection(socket, { onText, onClose, onError, onPing, head } = {}) {
  let closed = false;
  const textHandlers = [];
  const closeHandlers = [];
  const emitText = (text) => {
    onText?.(text);
    for (const handler of [...textHandlers]) handler(text);
  };
  const emitClose = (info) => {
    onClose?.(info);
    for (const handler of [...closeHandlers]) handler(info);
  };
  const conn = {
    socket,
    get open() {
      return !closed && !socket.destroyed;
    },
    /** Subscribe to text messages (the bridge uses this). */
    onText(handler) {
      textHandlers.push(handler);
      return conn;
    },
    /** Subscribe to the closing of this connection. */
    onClose(handler) {
      closeHandlers.push(handler);
      return conn;
    },
    sendText(text) {
      if (conn.open) socket.write(encodeFrame(String(text), { opcode: OPCODES.text }));
      return conn;
    },
    sendJson(value) {
      return conn.sendText(JSON.stringify(value));
    },
    /** Feed bytes that were already read off the socket (an upgrade's head buffer). */
    feed(chunk) {
      parser.push(chunk);
      return conn;
    },
    ping(payload = '') {
      if (conn.open) socket.write(encodeFrame(payload, { opcode: OPCODES.ping }));
      return conn;
    },
    close(code = CLOSE_NORMAL, reason = '') {
      if (closed) return conn;
      closed = true;
      if (!socket.destroyed) {
        socket.write(encodeCloseFrame(code, reason));
        socket.end();
        const timer = setTimeout(() => socket.destroy(), 200);
        timer.unref?.();
      }
      return conn;
    },
  };

  const parser = createFrameParser(({ opcode, payload }) => {
    if (opcode === OPCODES.text || opcode === OPCODES.binary) {
      emitText(payload.toString('utf8'));
    } else if (opcode === OPCODES.ping) {
      if (conn.open) socket.write(encodeFrame(payload, { opcode: OPCODES.pong }));
      onPing?.(payload.toString('utf8'));
    } else if (opcode === OPCODES.pong) {
      onPing?.(payload.toString('utf8'));
    } else if (opcode === OPCODES.close) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_NORMAL;
      conn.close(code);
      emitClose({ code, reason: payload.subarray(2).toString('utf8') });
    }
  }, { onProtocolError: (err) => onError?.(err) });

  if (head && head.length) parser.push(head);

  socket.on('data', (chunk) => {
    try {
      parser.push(chunk);
    } catch (err) {
      onError?.(err);
      conn.close(1002, 'protocol error');
    }
  });
  socket.on('error', (err) => onError?.(err));
  socket.on('close', () => {
    if (!closed) {
      closed = true;
      emitClose({ code: 1006, reason: 'socket closed' });
    }
  });

  return conn;
}

/**
 * Small browser-less websocket client (used by the tests and by any script that
 * wants to talk to the bridge). Resolves once the handshake completes.
 */
export function createClient(url, { timeout = 3000 } = {}) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80));
  const path = parsed.pathname + (parsed.search || '');
  const key = makeKey();

  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const client = {
      socket,
      messages: [],
      listeners: [],
      handshake: null,
      get connected() {
        return client.connectedFlag === true;
      },
      onMessage(handler) {
        client.listeners.push(handler);
        return client;
      },
      sendText(text) {
        if (socket.destroyed) throw new Error('client socket closed');
        socket.write(encodeFrame(text, { opcode: OPCODES.text, mask: true }));
        return client;
      },
      sendJson(value) {
        return client.sendText(JSON.stringify(value));
      },
      waitFor(predicate, ms = 3000) {
        const found = client.messages.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
          const handler = (msg) => {
            if (predicate(msg)) {
              clearTimeout(timer);
              client.listeners = client.listeners.filter((l) => l !== handler);
              res(msg);
            }
          };
          client.listeners.push(handler);
        });
      },
      close() {
        if (!socket.destroyed) {
          socket.write(encodeCloseFrame());
          socket.end();
        }
        return client;
      },
    };

    let handshakeBuffer = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('websocket handshake timeout'));
    }, timeout);

    const parser = createFrameParser(({ opcode, payload }) => {
      if (opcode === OPCODES.text || opcode === OPCODES.binary) {
        let value = payload.toString('utf8');
        try {
          value = JSON.parse(value);
        } catch {
          // keep the raw string
        }
        client.messages.push(value);
        for (const listener of [...client.listeners]) listener(value);
      } else if (opcode === OPCODES.ping) {
        socket.write(encodeFrame(payload, { opcode: OPCODES.pong, mask: true }));
      } else if (opcode === OPCODES.close) {
        client.connectedFlag = false;
        socket.end();
      }
    });

    socket.on('data', (chunk) => {
      if (upgraded) {
        parser.push(chunk);
        return;
      }
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const end = handshakeBuffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = handshakeBuffer.subarray(0, end).toString('utf8');
      const rest = handshakeBuffer.subarray(end + 4);
      const lines = head.split('\r\n');
      const status = lines[0];
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      clearTimeout(timer);
      client.handshake = { status, headers };
      if (!/^HTTP\/1\.1 101/.test(status)) {
        socket.destroy();
        reject(new Error(`handshake failed: ${status}`));
        return;
      }
      if (headers['sec-websocket-accept'] !== acceptValue(key)) {
        socket.destroy();
        reject(new Error('bad Sec-WebSocket-Accept'));
        return;
      }
      upgraded = true;
      client.connectedFlag = true;
      if (rest.length) parser.push(rest);
      resolve(client);
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      client.connectedFlag = false;
    });

    socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
  });
}
