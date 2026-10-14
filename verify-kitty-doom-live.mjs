/**
 * Live verification of the Kitty DOOM bridge against a real Orbit server process.
 *
 * Starts an isolated Orbit instance (own PORT, own ORBIT_RUNTIME_DIR, own token)
 * so the running deployment is never touched, then drives the actual
 * /api/kitty-doom route and websocket:
 *   - unauthenticated status and a foreign Origin are refused;
 *   - a wrong websocket token is refused;
 *   - an authenticated session renders real 320x200 RGB frames;
 *   - a kitty-encoded keypress changes the rendered frame;
 *   - kitty-encoded Ctrl+C reaches the app and ends the session;
 *   - the process is gone when the window (socket) closes.
 *
 * Usage: node verify-kitty-doom-live.mjs   (exits nonzero if a check fails)
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const repo = path.dirname(new URL(import.meta.url).pathname);
const port = Number(process.env.KITTY_DOOM_LIVE_PORT || 4398);
const token = randomBytes(24).toString("base64url") + randomBytes(12).toString("base64url");
const runtime = process.env.KITTY_DOOM_LIVE_RUNTIME || path.join(os.tmpdir(), `orbit-kitty-live-${randomBytes(4).toString("hex")}`);
const origin = `http://127.0.0.1:${port}`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

rmSync(runtime, { recursive: true, force: true });
const server = spawn(process.execPath, ["--experimental-strip-types", "server/index.mjs"], {
  cwd: repo,
  env: { ...process.env, PORT: String(port), ORBIT_TOKEN: token, ORBIT_RUNTIME_DIR: runtime, ORBIT_HOST: "127.0.0.1", ORBIT_PUBLIC_ORIGIN: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", chunk => (serverLog += chunk));
server.stderr.on("data", chunk => (serverLog += chunk));

async function status(headers) {
  const response = await fetch(`${origin}/api/kitty-doom`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify({ action: "status" }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function openSocket({ origin: socketOrigin = origin, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/kitty-doom`, { origin: socketOrigin, headers });
    socket.once("open", () => resolve(socket));
    socket.once("error", error => reject(error));
  });
}

const collectBinary = socket => {
  const buffers = [];
  const pending = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) buffers.push(Buffer.from(data));
    else {
      const message = JSON.parse(data.toString());
      if (message.type === "frame") pending.push(message);
    }
  });
  return { buffers, pending };
};

const digest = buffer => createHash("sha256").update(buffer).digest("hex");
const difference = (a, b) => {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) total += Math.abs(a[index] - b[index]);
  return total / (length || 1);
};

try {
  // Boot
  const bootDeadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < bootDeadline && !healthy) {
    try {
      healthy = (await fetch(`${origin}/api/health`, { headers: { Origin: origin } })).ok;
    } catch {
      /* not up yet */
    }
    if (!healthy) await wait(250);
  }
  if (!healthy) {
    check("isolated Orbit instance starts", false, serverLog.slice(-400));
    throw Error("server did not start");
  }
  check("isolated Orbit instance starts", true, `port ${port}, runtime ${runtime}`);

  // 1. Unauthenticated status
  const anonymous = await status({});
  check("status without an owner token is refused", anonymous.status === 403 && anonymous.body.code === "permission_denied", `HTTP ${anonymous.status}`);

  // 2. Foreign origin
  const foreign = await status({ Authorization: `Bearer ${token}`, Origin: "http://evil.example" });
  check("status with a foreign Origin is refused", foreign.status === 403, `HTTP ${foreign.status}`);

  // 3. Authenticated status
  const authorized = await status({ Authorization: `Bearer ${token}` });
  check("authenticated status reports the installed build", authorized.status === 200 && authorized.body.ok === true, JSON.stringify(authorized.body));
  check("freedoom WADs are the only selectable IWADs", JSON.stringify(authorized.body.wads) === '["freedoom1","freedoom2"]', JSON.stringify(authorized.body.wads));
  check("kitty-doom binary and WADs are present", authorized.body.binary_present === true && authorized.body.wad_present === true, `binary_present=${authorized.body.binary_present} wad_present=${authorized.body.wad_present}`);

  // 4. Wrong websocket token
  let wrongTokenClosed = null;
  try {
    const socket = await openSocket();
    socket.on("close", code => (wrongTokenClosed = code));
    socket.send(JSON.stringify({ type: "auth", token: "not-the-owner-token", cols: 320, rows: 200 }));
    const deadline = Date.now() + 5000;
    while (wrongTokenClosed === null && Date.now() < deadline) await wait(50);
    socket.close();
  } catch (error) {
    wrongTokenClosed = `error:${error.message}`;
  }
  check("a wrong websocket token is rejected", wrongTokenClosed === 1008, `close=${wrongTokenClosed}`);

  // 5. Real session
  const socket = await openSocket();
  const binary = collectBinary(socket);
  const messages = [];
  socket.on("message", data => {
    if (typeof data.toString === "function") {
      try {
        const message = JSON.parse(data.toString());
        messages.push(message);
        if (message.type !== "frame" && messages.filter(entry => entry.type !== "frame").length < 20)
          console.log(`INFO server message: ${JSON.stringify(message).slice(0, 200)}`);
      } catch {
        /* binary frame */
      }
    }
  });
  socket.send(JSON.stringify({ type: "auth", token, cols: 320, rows: 200, wad: "freedoom1" }));
  const started = Date.now();
  const deadline = started + 12000;
  while (!messages.some(message => message.type === "frame") && Date.now() < deadline) await wait(50);
  const ready = messages.find(message => message.type === "ready");
  check("authenticated session becomes ready", !!ready && ready.columns === 320 && ready.rows === 200, JSON.stringify(ready));
  const errors = messages.filter(message => message.type === "error").map(message => message.message);
  check("no session error", errors.length === 0, errors.join(" | ") || "none");

  await wait(9000);
  const frames = messages.filter(message => message.type === "frame");
  // The DOOM title screen is a static image that the game redraws hundreds of
  // times a second; the bridge suppresses byte-identical repeats, so a healthy
  // session is measured in changing frames, not raw redraws.
  check("changing frames stream over the authenticated websocket", frames.length > 10, `${frames.length} frames in ${Date.now() - started}ms`);
  const first = frames[0];
  check("frames are 320x200 RGB", first && first.format === "rgb" && first.width === 320 && first.height === 200 && first.bytes === 192000, JSON.stringify(first));
  const payloads = binary.buffers;
  check("binary payloads arrive for every frame header", payloads.length === frames.length, `${payloads.length} payloads / ${frames.length} headers`);
  const unchanged = frames.at(-1)?.unchanged ?? 0;
  check("identical redraws are suppressed by the bridge", unchanged > 0, `${unchanged} identical redraws skipped`);
  const distinct = new Set(payloads.at(-1)).size;
  check("frames carry a real picture, not a blank screen", distinct > 8 && payloads.at(-1).some(byte => byte !== 0), `${distinct} distinct byte values`);
  const placed = frames.find(frame => frame.columns > 0);
  check("the transmit frame carries the advertised 320x200 cell box", placed?.columns === 320 && placed?.rows === 200, JSON.stringify(placed && { columns: placed.columns, rows: placed.rows }));
  const unique = new Set(payloads.map(digest)).size;
  check("the rendered picture changes over time (animating game)", unique > 5, `${unique} distinct frames`);
  const rate = Math.round((payloads.length / Math.max(1, Date.now() - started)) * 1000);
  console.log(`INFO delivered ${payloads.length} frames (${rate}/s, paced by the bridge; ${unchanged} identical redraws suppressed)`);

  // 6. Keypress changes the frame; Ctrl+C ends the session
  const cpu = await new Promise(resolve => {
    const ps = spawn("ps", ["-eo", "%cpu,args"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    ps.stdout.on("data", chunk => (out += chunk));
    ps.on("close", () => {
      const line = out.split("\n").find(entry => entry.includes("build/kitty-doom") && !entry.includes("ps -eo"));
      resolve(line ? line.trim().split(/\s+/)[0] : "unknown");
    });
  });
  console.log(`INFO kitty-doom process CPU while rendering: ${cpu}% (it redraws an unchanged screen hundreds of times a second)`);
  const beforeKey = payloads.at(-1);
  const beforeCount = payloads.length;
  socket.send(JSON.stringify({ type: "input", data: "\x1b[13u" }));
  const keyDeadline = Date.now() + 6000;
  while (payloads.length < beforeCount + 5 && Date.now() < keyDeadline) await wait(50);
  const afterKey = payloads.at(-1);
  check("a kitty-encoded keypress changes the rendered frame", payloads.length > beforeCount && digest(beforeKey) !== digest(afterKey), `diff=${difference(beforeKey, afterKey).toFixed(1)} across ${payloads.length - beforeCount} new frames`);

  socket.send(JSON.stringify({ type: "resize", cols: 160, rows: 100 }));
  await wait(400);
  check("resize is accepted while playing", messages.every(message => message.type !== "exit"), "session still running");

  socket.send(JSON.stringify({ type: "input", data: "\x1b[99;5u" })); // kitty-encoded Ctrl+C
  const exitDeadline = Date.now() + 8000;
  while (!messages.some(message => message.type === "exit") && Date.now() < exitDeadline) await wait(50);
  const exit = messages.find(message => message.type === "exit");
  check("kitty-encoded Ctrl+C reaches the app and ends the session", !!exit, JSON.stringify(exit));

  // 7. Closing the window kills the process
  socket.close();
  await wait(1200);
  const afterClose = await status({ Authorization: `Bearer ${token}` });
  const lingering = (await new Promise(resolve => {
    const ps = spawn("ps", ["-eo", "args"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    ps.stdout.on("data", chunk => (out += chunk));
    ps.on("close", () => resolve(out.split("\n").filter(line => line.includes("kitty-doom/build/kitty-doom") && !line.includes("ps -eo"))));
  })).length;
  check("the session is released when the window closes", afterClose.body.sessions === 0, `sessions=${afterClose.body.sessions}`);
  check("no kitty-doom process is left behind", lingering === 0, `${lingering} process(es)`);
} catch (error) {
  check("verification completed", false, error.stack?.split("\n").slice(0, 3).join(" ") || String(error));
} finally {
  server.kill("SIGTERM");
  await wait(500);
  server.kill("SIGKILL");
  rmSync(runtime, { recursive: true, force: true });
  const failed = results.filter(result => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
