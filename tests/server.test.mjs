import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { WebSocket } from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { tokenMatches, geometry, allowedRequest } from "../server/security.mjs";
const port = 14318,
  base = `http://127.0.0.1:${port}`,
  token = "orbit-test-only-token-01234567890123456789";
let child;
before(async () => {
  child = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, PORT: String(port), ORBIT_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (d) => (errors += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    if (child.exitCode !== null) throw Error(errors);
    await delay(50);
  }
  throw Error("Server startup timeout");
});
after(async () => {
  child?.kill("SIGTERM");
  await delay(100);
});
function connection(origin = base) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/api/terminal", {
      origin,
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}
function until(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Error("Message timeout"));
    }, timeout);
    function listener(raw) {
      const m = JSON.parse(raw);
      if (predicate(m)) {
        cleanup();
        resolve(m);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      ws.off("message", listener);
    }
    ws.on("message", listener);
  });
}
async function auth(ws) {
  const ready = until(ws, (m) => m.type === "ready");
  ws.send(JSON.stringify({ type: "auth", token, cols: 80, rows: 24 }));
  await ready;
}
test("strict token and terminal dimensions", () => {
  assert(tokenMatches(token, token));
  assert(!tokenMatches("x", token));
  assert(!tokenMatches(null, token));
  assert(geometry(80, 24));
  for (const dims of [
    [0, 1],
    [800, 25],
    [80, 0],
    [NaN, 10],
    [12.5, 20],
  ])
    assert(!geometry(...dims));
  assert(
    !allowedRequest({ headers: { host: `evil:${port}`, origin: base } }, port),
  );
});
test("static app and security headers", async () => {
  const r = await fetch(base);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Orbit/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(
    r.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
});
test("auth requires allowed Origin and correct token", async () => {
  for (const [origin, value, status] of [
    ["https://evil.example", token, 403],
    [base, "wrong", 401],
    [base, token, 200],
  ]) {
    const r = await fetch(base + "/api/auth", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: value }),
    });
    assert.equal(r.status, status);
  }
});
test("host header resists DNS rebinding", async () => {
  const status = await new Promise((resolve, reject) => {
    http
      .get(
        base + "/api/health",
        { headers: { Host: `evil.example:${port}` } },
        (r) => {
          r.resume();
          resolve(r.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(status, 403);
});
test("WebSocket rejects foreign Origin", async () => {
  await assert.rejects(connection("https://evil.example"), /403/);
});
test("wrong websocket token never creates a shell", async () => {
  const ws = await connection();
  const closed = new Promise((resolve) => ws.once("close", resolve));
  ws.send(JSON.stringify({ type: "auth", token: "wrong", cols: 80, rows: 24 }));
  assert.equal(await closed, 1008);
  assert.equal((await (await fetch(base + "/api/health")).json()).sessions, 0);
});
test("PTY runs commands, resizes, and cleans up on disconnect", async () => {
  const ws = await connection();
  try {
    await auth(ws);
    let output = "";
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "data") {
        output += m.data;
        ws.send(JSON.stringify({ type: "ack", length: m.data.length }));
      }
    });
    ws.send(JSON.stringify({ type: "resize", cols: 103, rows: 37 }));
    ws.send(
      JSON.stringify({
        type: "input",
        data: "printf 'ORBIT_%s_DONE\\n' VERIFIED; stty size\r",
      }),
    );
    for (let i = 0; i < 100 && !output.includes("ORBIT_VERIFIED_DONE"); i++)
      await delay(30);
    assert.match(output, /ORBIT_VERIFIED_DONE/);
    for (let i = 0; i < 100 && !output.includes("37 103"); i++) await delay(30);
    assert.match(output, /37 103/);
  } finally {
    ws.close();
  }
  for (let i = 0; i < 100; i++) {
    if ((await (await fetch(base + "/api/health")).json()).sessions === 0)
      return;
    await delay(30);
  }
  assert.fail("PTY session not cleaned up");
});
test("invalid message closes session", async () => {
  const ws = await connection();
  await auth(ws);
  const closed = new Promise((resolve) => ws.once("close", resolve));
  ws.send(JSON.stringify({ type: "resize", cols: -10, rows: 10 }));
  assert.equal(await closed, 1008);
});
test("flow control pauses output and resumes after acknowledged writes", async () => {
  const ws = await connection();
  try {
    await auth(ws);
    let received = 0,
      ack = true,
      output = "";
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type !== "data") return;
      output += m.data;
      received += m.data.length;
      if (ack) ws.send(JSON.stringify({ type: "ack", length: m.data.length }));
    });
    await delay(100);
    received = 0;
    ack = false;
    ws.send(
      JSON.stringify({
        type: "input",
        data: "head -c 400000 /dev/zero | tr '\\0' x; printf '\\nFLOW_DONE\\n'\r",
      }),
    );
    await delay(400);
    const pausedAt = received;
    assert(
      pausedAt >= 128000 && pausedAt < 350000,
      `Expected bounded output, got ${pausedAt}`,
    );
    await delay(250);
    assert.equal(received, pausedAt);
    ack = true;
    ws.send(JSON.stringify({ type: "ack", length: received }));
    for (let i = 0; i < 100 && !output.endsWith("FLOW_DONE\r\n"); i++) {
      if (output.includes("\r\nFLOW_DONE\r\n")) break;
      await delay(40);
    }
    assert.match(output, /\r\nFLOW_DONE\r\n/);
  } finally {
    ws.close();
  }
});
