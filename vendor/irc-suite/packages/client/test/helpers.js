// Shared test helpers: a fake IRC server that records every line it receives.
import net from 'node:net';

/** Start a fake IRC server on port 0. Returns counters plus send/wait helpers. */
export async function startFakeServer() {
  const state = { lines: [], sockets: [] };
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    state.sockets.push(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line) state.lines.push(line);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    state,
    port: server.address().port,
    /** Send a raw line to the newest connection. */
    send(line) {
      const socket = state.sockets.at(-1);
      if (!socket) throw new Error('no client connected yet');
      socket.write(line + '\r\n');
    },
    waitForLine(re, timeout = 2000) {
      return waitFor(() => state.lines.find((l) => re.test(l)), { timeout, label: `line ${re}` });
    },
    async close() {
      for (const socket of state.sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Poll until predicate() is truthy, then return its value. */
export function waitFor(predicate, { timeout = 2000, interval = 5, label = 'condition' } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error(`timeout waiting for ${label}`));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** Resolve with the next emission of `event` (single value, or an array for multi-arg). */
export function waitForEvent(emitter, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeout);
    function onEvent(...args) {
      clearTimeout(timer);
      resolve(args.length > 1 ? args : args[0]);
    }
    emitter.once(event, onEvent);
  });
}
