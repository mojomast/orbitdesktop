/**
 * Kitty DOOM bridge.
 *
 * Runs jserv/kitty-doom (a DOOM port from Kyle's ~/src/kitty-doom checkout that
 * renders through the Kitty graphics protocol) inside a real PTY and translates
 * its frames into a browser-renderable stream carried on Orbit's existing
 * authenticated origin. Nothing new is exposed: the HTTP status route and the
 * upgrade share the running server's port, Host/Origin checks and owner token.
 *
 * What the bridge does that a plain terminal does not:
 *  - spawns the binary with TERM=xterm-kitty (kitty-doom short-circuits its
 *    capability probe on that TERM) and still answers the ESC_G a=q probe with
 *    "OK" when a build does ask;
 *  - answers the app's terminal queries: the Kitty keyboard-protocol query
 *    (ESC[?u), the CUP+DSR screen-cell probe (ESC[6n) and primary DA (ESC[c) —
 *    without the DSR reply kitty-doom falls back to an 80x24 grid and renders
 *    the 320x200 image into a badly distorted cell box;
 *  - decodes the graphics APC stream: chunked base64 (m=1), RGB (f=24), RGBA
 *    (f=32) and PNG (f=100) transmissions plus animation frames (a=f) and the
 *    first transmit+display (a=T);
 *  - forwards keyboard/mouse input as terminal escape sequences to the PTY.
 *
 * The PTY is bound to one websocket connection: the process is killed when the
 * window (socket) closes. No file, credential or new listener is exposed.
 */
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";
import { tokenMatches, allowedRequest, geometry } from "./security.mjs";

/** Freedoom only: never the commercial IWADs, never a network download. */
export const KITTY_DOOM_WADS = Object.freeze({
  freedoom1: "wads/freedoom1.wad",
  freedoom2: "wads/freedoom2.wad",
});

/**
 * Programs this window may run. The client sends a *key*, never a command: the
 * argv is fixed here, so the surface cannot be turned into arbitrary execution.
 * "script" programs are the bridge's own demonstration clients — any program
 * that speaks the Kitty graphics protocol renders in this pane the same way.
 */
export const KITTY_DOOM_PROGRAMS = Object.freeze({
  freedoom1: { kind: "wad", title: "Freedoom 1 (kitty-doom)", wad: "wads/freedoom1.wad" },
  freedoom2: { kind: "wad", title: "Freedoom 2 (kitty-doom)", wad: "wads/freedoom2.wad" },
  "graphics-tour": { kind: "script", title: "Graphics protocol tour", script: "kitty-graphics-demo.py" },
  "terminal-probe": { kind: "script", title: "Terminal emulation probe", script: "kitty-terminal-probe.py" },
});
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
/**
 * Advertised terminal grid. kitty-doom asks the terminal for its cell grid and
 * renders its 320x200 image into it, so a 320x200 grid makes one cell equal one
 * visible image pixel (also the unit of its mouse deltas).
 */
export const KITTY_DOOM_COLUMNS = 320;
export const KITTY_DOOM_ROWS = 200;

const MAX_SESSIONS = 4;
const MAX_APC_CHARS = 1024 * 1024; // one chunk header + base64 payload
const MAX_TRANSMISSION_CHARS = 8 * 1024 * 1024;
const MAX_INPUT_CHARS = 8192;
const MAX_SOCKET_BUFFERED = 1536 * 1024;
/** kitty-doom renders far faster than a display needs; the bridge paces frames. */
const FRAME_FLUSH_MS = 25;
const APC_START = Buffer.from("\x1b_G", "latin1");
const APC_END = Buffer.from("\x1b\\", "latin1");
/** (query, reply) pairs the emulated terminal answers. */
const KKP_REPLY = "\x1b[?11u"; // disambiguate + event types + all keys as escape codes
const DA1_REPLY = "\x1b[?62;c";
/** Reply to a Kitty graphics capability probe (ESC_G a=q): kitty-doom looks for "ESC_Gi=<id>". */
export function kittyCapabilityReply(id) {
  const safe = typeof id === "string" ? id.replace(/[^0-9A-Za-z_.-]/g, "").slice(0, 32) : "";
  return `\x1b_Gi=${safe};OK\x1b\\`;
}

function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * Streaming decoder for the Kitty graphics APC subset kitty-doom emits.
 * Chunked transmissions are assembled; only a complete frame is emitted, so a
 * partial frame can never reach a renderer.
 */
export function createKittyGraphicsParser({
  onFrame = () => {},
  onReply = () => {},
  onCapability = () => {},
  onDelete = () => {},
  onText = () => {},
  onNotice = () => {},
} = {}) {
  let pending = Buffer.alloc(0);
  let carry = "";
  let transmission = null;
  /** Placement cell box per image id, so later animation frames stay self-describing. */
  const placements = new Map();

  function complete() {
    const current = transmission;
    transmission = null;
    if (!current) return;
    const { width, height, format, id, display } = current;
    if (current.columns > 0 && current.rows > 0) {
      if (placements.size >= 8 && !placements.has(id)) placements.delete(placements.keys().next().value);
      placements.set(id, { columns: current.columns, rows: current.rows });
    }
    if (!width || !height || width < 1 || height < 1 || width > 4096 || height > 4096) {
      onNotice("Ignored a graphics frame with an invalid geometry.");
      return;
    }
    const data = Buffer.from(current.parts.join(""), "base64");
    const placement = current.columns > 0 && current.rows > 0
      ? { columns: current.columns, rows: current.rows }
      : placements.get(id) || { columns: 0, rows: 0 };
    let kind;
    if (format === "24") kind = "rgb";
    else if (format === "32") kind = "rgba";
    else if (format === "100") kind = "png";
    else {
      onNotice(`Ignored an unsupported graphics format (f=${format || "none"}).`);
      return;
    }
    const expected = kind === "rgb" ? width * height * 3 : kind === "rgba" ? width * height * 4 : 0;
    if (expected && data.length !== expected) {
      onNotice("Ignored a graphics frame whose payload size did not match its geometry.");
      return;
    }
    if (!display) return; // transmit-only (a=t) is decoded but never displayed
    onFrame({
      id,
      format: kind,
      width,
      height,
      columns: placement.columns,
      rows: placement.rows,
      chunks: current.chunks,
      data,
    });
  }

  function apc(body) {
    if (!body.length || body[0] !== 0x47 /* G */) {
      onNotice("Ignored an unsupported terminal control sequence.");
      return;
    }
    const value = body.subarray(1).toString("latin1");
    const separator = value.indexOf(";");
    const controlText = separator < 0 ? value : value.slice(0, separator);
    const payload = separator < 0 ? "" : value.slice(separator + 1);
    const control = {};
    for (const field of controlText.split(",")) {
      const equals = field.indexOf("=");
      if (equals <= 0) continue;
      control[field.slice(0, equals)] = field.slice(equals + 1);
    }
    const action = control.a ?? "";
    if (action === "q") return onCapability(control.i ?? "");
    if (action === "d") return onDelete(control.i ?? "");
    if (action === "a") return; // animation control (an animation frame is deleted per rendered frame)
    const more = control.m === "1";
    const metadata = control.s !== undefined && control.v !== undefined;
    if (metadata) {
      // For animation frames (a=f) "r" is the frame index, not a row count, so a
      // placement cell box is only meaningful on a transmit+display frame.
      const placement = action === "T" || action === "t";
      transmission = {
        id: control.i ?? "",
        format: control.f ?? "",
        width: integer(control.s) ?? 0,
        height: integer(control.v) ?? 0,
        columns: placement ? integer(control.c) ?? 0 : 0,
        rows: placement ? integer(control.r) ?? 0 : 0,
        display: action !== "t",
        parts: [],
        chars: 0,
        chunks: 0,
      };
    }
    if (!transmission) {
      onNotice("Ignored a graphics chunk with no transmission to continue.");
      return;
    }
    if (payload.length <= MAX_APC_CHARS && transmission.chars + payload.length <= MAX_TRANSMISSION_CHARS)
      transmission.parts.push(payload);
    else {
      transmission = null;
      onNotice("Ignored an oversized graphics transmission.");
      return;
    }
    transmission.chars += payload.length;
    transmission.chunks += 1;
    if (!more) complete();
  }

  function text(bytes) {
    const value = bytes.toString("latin1");
    onText(value);
    // A query may be split across PTY reads; only answer matches that end inside
    // the new bytes so no query is answered twice.
    const combined = carry + value;
    const boundary = carry.length;
    for (const [pattern, reply] of [
      ["\x1b[?u", () => KKP_REPLY],
      ["\x1b[6n", () => `\x1b[${size.rows};${size.columns}R`],
      ["\x1b[c", () => DA1_REPLY],
    ]) {
      let index = combined.indexOf(pattern);
      while (index >= 0) {
        if (index + pattern.length > boundary) onReply(reply());
        index = combined.indexOf(pattern, index + 1);
      }
    }
    carry = combined.slice(-16);
  }

  const size = { columns: KITTY_DOOM_COLUMNS, rows: KITTY_DOOM_ROWS };

  return {
    /** Advertised grid used for cursor-position replies. */
    setSize(columns, rows) {
      size.columns = columns;
      size.rows = rows;
    },
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "latin1");
      pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let offset = 0;
      while (offset < pending.length) {
        const start = pending.indexOf(APC_START, offset);
        if (start < 0) {
          const tail = pending.subarray(offset);
          // A graphics sequence can be split between the ESC, the '_' and the G.
          const keep = tail.length >= 2 && tail[tail.length - 2] === 0x1b && tail[tail.length - 1] === 0x5f
            ? 2
            : tail.length && tail[tail.length - 1] === 0x1b ? 1 : 0;
          if (tail.length > keep) text(tail.subarray(0, tail.length - keep));
          pending = keep ? Buffer.from(tail.subarray(tail.length - keep)) : Buffer.alloc(0);
          return;
        }
        if (start > offset) text(pending.subarray(offset, start));
        const end = pending.indexOf(APC_END, start + 2);
        if (end < 0) {
          if (pending.length - start > MAX_TRANSMISSION_CHARS) {
            pending = Buffer.alloc(0);
            onNotice("Ignored an oversized terminal control sequence.");
            return;
          }
          pending = pending.subarray(start);
          return;
        }
        apc(pending.subarray(start + 2, end));
        offset = end + 2;
      }
      if (offset >= pending.length) pending = Buffer.alloc(0);
    },
  };
}

/**
 * One kitty-doom (or demo) process in its own PTY. Callers own lifecycle:
 * `kill()` ends the process group and `resize()` matches the client's grid.
 */
export function createKittyDoomProcess({
  binary,
  directory,
  program,
  wad,
  columns = KITTY_DOOM_COLUMNS,
  rows = KITTY_DOOM_ROWS,
  env = process.env,
  onFrame = () => {},
  onNotice = () => {},
  onText = () => {},
  onExit = () => {},
} = {}) {
  // `??` not `||`: an explicitly empty program key must be refused, not silently
  // defaulted to Freedoom 1.
  const key = program ?? wad ?? "freedoom1";
  const entry = KITTY_DOOM_PROGRAMS[key];
  if (!entry) throw Object.assign(Error("Unknown program"), { code: "invalid_request" });
  if (typeof binary !== "string" || !binary) throw Object.assign(Error("kitty-doom binary is not configured"), { code: "unavailable" });
  if (typeof directory !== "string" || !directory) throw Object.assign(Error("kitty-doom directory is not configured"), { code: "unavailable" });
  let command;
  let args;
  if (entry.kind === "wad") {
    const iwad = entry.wad;
    if (!existsSync(binary) || !existsSync(path.join(directory, iwad))) throw Object.assign(Error("kitty-doom binary or WAD is missing"), { code: "unavailable" });
    command = binary;
    args = ["-iwad", iwad, "-nosound"];
  } else {
    const script = path.join(SCRIPT_DIRECTORY, entry.script);
    const python = env.ORBIT_PYTHON || "/usr/bin/python3";
    if (!existsSync(script) || !existsSync(python)) throw Object.assign(Error("The demonstration program is missing"), { code: "unavailable" });
    command = python;
    args = [script];
  }
  // A minimal environment: the owner token and any configured API key must never
  // reach the child process, exactly as for spawned host shells.
  const childEnv = {
    TERM: "xterm-kitty",
    COLORTERM: "truecolor",
    HOME: env.HOME || os.homedir(),
    PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: env.LANG || "C.UTF-8",
    PYTHONUNBUFFERED: "1",
  };
  const child = pty.spawn(command, args, {
    name: "xterm-kitty",
    cols: columns,
    rows,
    cwd: directory,
    env: childEnv,
    encoding: null,
  });
  let killed = false;
  /** Emulation notices fire once per kind, so the pane log stays readable. */
  const announced = new Set();
  const announce = (label, value) => {
    if (announced.has(label)) return;
    announced.add(label);
    onNotice(value);
  };
  const parser = createKittyGraphicsParser({
    onFrame,
    onNotice,
    onText,
    onReply: reply => {
      write(reply);
      if (reply === KKP_REPLY) announce("kkp", "Answered the Kitty keyboard-protocol query (ESC[?u).");
      else if (reply === DA1_REPLY) announce("da1", "Answered the primary device-attributes query (ESC[c).");
      else announce("dsr", `Answered the cursor-position query (ESC[6n) with ${reply.replace(/\x1b/g, "ESC")} — this is the grid the program renders into.`);
    },
    onCapability: id => {
      write(kittyCapabilityReply(id));
      announce("capability", `Answered the Kitty graphics capability probe (a=q, i="${id}") — without this the program never draws.`);
    },
  });
  parser.setSize(columns, rows);
  function write(value) {
    if (killed || typeof value !== "string" || !value.length) return;
    try {
      child.write(value);
    } catch {
      /* The PTY is gone; exit handling reports it once. */
    }
  }
  child.onData(data => parser.push(data));
  child.onExit(event => {
    killed = true;
    onExit(event || { exitCode: 0 });
  });
  return {
    write,
    resize(nextColumns, nextRows) {
      if (!geometry(nextColumns, nextRows)) return false;
      parser.setSize(nextColumns, nextRows);
      try {
        child.resize(nextColumns, nextRows);
      } catch {
        return false;
      }
      return true;
    },
    kill() {
      if (killed) return;
      killed = true;
      try {
        child.kill();
      } catch {
        /* Already gone. */
      }
    },
  };
}

/**
 * Owner-authenticated HTTP status route plus the websocket bridge. The upgrade
 * path keeps the running server's Host/Origin checks and one process per socket.
 */
export function createKittyDoomService({
  token,
  port,
  devOrigins = [],
  reply,
  binary,
  directory,
  env = process.env,
  maxSessions = MAX_SESSIONS,
} = {}) {
  const home = os.homedir();
  const gameDirectory = directory || env.ORBIT_KITTY_DOOM_DIR || path.join(home, "src", "kitty-doom");
  const gameBinary = binary || env.ORBIT_KITTY_DOOM_BINARY || path.join(gameDirectory, "build", "kitty-doom");
  const sessions = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

  function authorized(req) {
    const authorization = req.headers.authorization;
    return allowedRequest(req, port, devOrigins) && typeof authorization === "string" &&
      authorization.startsWith("Bearer ") && tokenMatches(authorization.slice(7), token);
  }

  async function handle(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return reply(res, 405, { ok: false, code: "invalid_request" });
    if (!authorized(req)) return reply(res, 403, { ok: false, code: "permission_denied" });
    let raw = "";
    try {
      for await (const part of req) {
        raw += part;
        if (raw.length > 2048) return reply(res, 413, { ok: false, code: "limit_exceeded" });
      }
      const body = JSON.parse(raw);
      if (!body || body.action !== "status") return reply(res, 400, { ok: false, code: "invalid_request" });
    } catch {
      return reply(res, 400, { ok: false, code: "invalid_request" });
    }
    return reply(res, 200, {
      ok: true,
      protocol: 2,
      sessions: sessions.size,
      max_sessions: maxSessions,
      columns: KITTY_DOOM_COLUMNS,
      rows: KITTY_DOOM_ROWS,
      wads: Object.keys(KITTY_DOOM_WADS),
      programs: Object.entries(KITTY_DOOM_PROGRAMS).map(([id, entry]) => ({
        id,
        title: entry.title,
        kind: entry.kind,
        available: entry.kind === "wad"
          ? existsSync(gameBinary) && existsSync(path.join(gameDirectory, entry.wad))
          : existsSync(path.join(SCRIPT_DIRECTORY, entry.script)),
      })),
      binary_present: existsSync(gameBinary),
      wad_present: Object.keys(KITTY_DOOM_WADS).every(name => existsSync(path.join(gameDirectory, KITTY_DOOM_WADS[name]))),
    });
  }

  function upgrade(req, socket, head) {
    const pathname = String(req.url || "").split("?")[0];
    if (pathname !== "/api/kitty-doom" || !allowedRequest(req, port, devOrigins) || sessions.size >= maxSessions) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
  }

  wss.on("connection", ws => {
    let session = null;
    let authed = false;
    let closed = false;
    let latest = null;
    let flushTimer = null;
    let delivered = 0;
    let dropped = 0;
    let unchanged = 0;
    let lastSent = null;
    let lastPong = Date.now();
    const send = message => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const authTimeout = setTimeout(() => ws.close(1008, "Authentication timeout"), 5000);
    const health = setInterval(() => {
      if (Date.now() - lastPong > 60000) {
        ws.terminate();
        return;
      }
      try {
        ws.ping();
      } catch {
        /* The close handler tidies up. */
      }
    }, 15000);
    const flush = () => {
      flushTimer = null;
      if (closed || ws.readyState !== WebSocket.OPEN || !latest) return;
      if (ws.bufferedAmount > MAX_SOCKET_BUFFERED) {
        dropped += 1;
        latest = null;
        return;
      }
      const frame = latest;
      latest = null;
      // The game redraws an unchanged screen hundreds of times a second (idle
      // menus, paused frames). Resending identical bytes only wastes bandwidth.
      if (lastSent && frame.data.equals(lastSent)) {
        unchanged += 1;
        return;
      }
      delivered += 1;
      lastSent = frame.data;
      send({
        type: "frame",
        format: frame.format,
        width: frame.width,
        height: frame.height,
        columns: frame.columns,
        rows: frame.rows,
        chunks: frame.chunks ?? 1,
        bytes: frame.data.length,
        frames: delivered,
        dropped,
        unchanged,
      });
      ws.send(frame.data, { binary: true });
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(authTimeout);
      clearInterval(health);
      if (flushTimer) clearTimeout(flushTimer);
      if (session) {
        sessions.delete(session);
        session.kill();
        session = null;
      }
    };
    ws.on("pong", () => (lastPong = Date.now()));
    ws.on("message", raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        ws.close(1008, "Invalid JSON");
        return;
      }
      if (!message || typeof message !== "object") {
        ws.close(1008, "Invalid message");
        return;
      }
      if (!authed) {
        if (message.type !== "auth" || !tokenMatches(message.token, token) || !geometry(message.cols, message.rows)) {
          ws.close(1008, "Authentication rejected");
          return;
        }
        const program = typeof message.program === "string" && Object.hasOwn(KITTY_DOOM_PROGRAMS, message.program)
          ? message.program
          : typeof message.wad === "string" && Object.hasOwn(KITTY_DOOM_WADS, message.wad) ? message.wad : "freedoom1";
        let process;
        try {
          process = createKittyDoomProcess({
            binary: gameBinary,
            directory: gameDirectory,
            program,
            columns: message.cols,
            rows: message.rows,
            env,
            onNotice: notice => send({ type: "notice", message: notice }),
            onText: value => {
              const text = value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
              if (text) send({ type: "output", message: text.slice(0, 500) });
            },
            onExit: ({ exitCode }) => {
              send({ type: "exit", code: Number.isInteger(exitCode) ? exitCode : 0 });
              ws.close(1000, "Session ended");
            },
            onFrame: frame => {
              latest = frame;
              if (!flushTimer) flushTimer = setTimeout(flush, FRAME_FLUSH_MS);
            },
          });
        } catch (error) {
          send({ type: "error", message: error?.code === "unavailable"
            ? "kitty-doom is not installed on this host (expected build/kitty-doom and Freedoom WADs)."
            : "kitty-doom could not be started." });
          ws.close(1011, "Spawn failed");
          return;
        }
        clearTimeout(authTimeout);
        authed = true;
        session = process;
        sessions.add(process);
        send({ type: "ready", protocol: 2, program, title: KITTY_DOOM_PROGRAMS[program].title, columns: message.cols, rows: message.rows });
        return;
      }
      if (message.type === "input" && typeof message.data === "string" && message.data.length <= MAX_INPUT_CHARS) session?.write(message.data);
      else if (message.type === "resize" && geometry(message.cols, message.rows)) session?.resize(message.cols, message.rows);
      else if (message.type === "ping") send({ type: "pong" });
      else if (message.type !== "echo") ws.close(1008, "Invalid protocol message");
    });
    ws.on("close", finish);
    ws.on("error", finish);
  });

  return {
    handle,
    upgrade,
    sessionCount: () => sessions.size,
    close() {
      for (const session of [...sessions]) {
        sessions.delete(session);
        session.kill();
      }
      for (const ws of wss.clients) {
        try {
          ws.terminate();
        } catch {
          /* Already closed. */
        }
      }
      try {
        wss.close();
      } catch {
        /* Already closed. */
      }
    },
  };
}
