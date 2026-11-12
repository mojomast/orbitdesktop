/**
 * Kitty DOOM surface (orbit://surface/kitty-doom).
 *
 * A canvas terminal for the Kitty graphics protocol, paired with the server-side
 * bridge in server/kitty-doom.mjs. One websocket = one kitty-doom process: closing
 * the window (or pressing Stop) ends the process, and the pane requires the owner
 * host token exactly like the built-in terminal.
 *
 * Rendering: the bridge sends a JSON frame header followed by the raw pixels, so
 * the canvas only copies bytes (RGB -> RGBA) and scales 320x200 to the pane.
 * Input: keys are encoded with the Kitty keyboard protocol (csv u) because
 * kitty-doom ignores plain characters once that protocol is active. Its engine
 * only maps arrow and function keys in its legacy CSI/SS3 parser, so those two
 * families are sent as legacy sequences — otherwise the codepoints it would
 * receive are not the keys it knows.
 */
import { el, button, select } from "./dom";
import "./kitty-doom.css";

const COLUMNS = 320;
const ROWS = 200;
const MAX_CANVAS_SCALE = 6;
/** Mirrors the server's allowlist: the client sends this key, never a command. */
const PROGRAMS: Array<[string, string]> = [
  ["freedoom1", "Freedoom 1 (kitty-doom)"],
  ["freedoom2", "Freedoom 2 (kitty-doom)"],
  ["graphics-tour", "Graphics protocol tour"],
  ["terminal-probe", "Terminal emulation probe"],
];
const LOG_LIMIT = 80;

/**
 * The explanation shown in the pane. Kept in the client so the answer to "what
 * is actually happening here" travels with the app; every claim below is
 * something the bridge does in server/kitty-doom.mjs.
 */
const HOW_IT_WORKS: Array<[string, string]> = [
  ["The program is real and local, the browser is the terminal",
    "kitty-doom (or the demo program) runs as a normal process on this host in its own PTY — " +
    "not Doom in WebAssembly, not an emulator. Orbit is playing the part of the terminal " +
    "emulator: it answers the program's queries, decodes its graphics, and paints the pixels " +
    "onto this canvas. Your keypresses go back down the PTY as terminal escape sequences."],
  ["Why the graphics work at all",
    "kitty-doom only draws if the terminal answers its Kitty graphics capability probe " +
    "(ESC_G a=q). When it does, the program streams images as base64 inside APC sequences " +
    "(ESC_G … ESC\\). The bridge reassembles those chunks (m=1 continuations), decodes RGB " +
    "(f=24), RGBA (f=32) and PNG (f=100) frames plus animation frames, then sends the raw " +
    "pixels to this pane over a websocket on Orbit's own authenticated origin."],
  ["The terminal-emulation half is the hard part",
    "It is not the pixels. kitty-doom asks the terminal for its cursor position (ESC[6n) and " +
    "derives its cell grid from the reply — answer nothing and it falls back to 80x24 and " +
    "renders the 320x200 image into a badly distorted box. It also asks the Kitty " +
    "keyboard-protocol query (ESC[?u) and primary device attributes (ESC[c). The bridge " +
    "answers all of them, which is why one cell equals one image pixel here."],
  ["Why this cannot be a tmux pane",
    "A normal Orbit terminal runs inside tmux, where TERM is tmux-256color — no graphics " +
    "protocol to draw into. Measured on this host: the same program's graphics sequences " +
    "reach the terminal directly, and zero reach it through a tmux layer, even with " +
    "allow-passthrough set. This window therefore bypasses tmux and holds the PTY directly " +
    "rather than pretending to support graphics it cannot render."],
  ["Four programs in the picker, one bridge",
    "Freedoom 1 and 2 are the real kitty-doom games. The other two entries are this " +
    "project's own test clients, and neither knows anything about Doom: the graphics tour " +
    "emits one scene per wire format the bridge decodes — chunked RGB (f=24), RGBA with a " +
    "real alpha channel (f=32), a zlib PNG (f=100) and an a=f animation — narrating each " +
    "one in Live events; the terminal probe asks the bridge the exact questions kitty-doom " +
    "asks (Kitty keyboard protocol, cursor position, primary device attributes, graphics " +
    "capability), prints the answers it receives, then draws a frame so a correct reply is " +
    "visible rather than asserted. Both are stdlib Python spawned the same way the game is, " +
    "which is the point: anything that speaks this protocol renders in this pane."],
  ["What is exposed, and what is not",
    "One websocket = one process; closing this window kills it. The bridge reuses Orbit's " +
    "existing port, Host/Origin checks and owner token — it opens no new listener and needs " +
    "no extra credential. The child gets a minimal environment, so the owner token never " +
    "reaches it. The picker sends a key from a server-side allowlist: the argv is fixed on " +
    "the server, so this cannot become arbitrary command execution."],
  ["What this proves, and what it does not",
    "Frames are decoded and displayed; the byte counts, chunk counts and frame rates below " +
    "are measured, not estimated. Identification redraws that repeat identical bytes are " +
    "suppressed to save bandwidth, so the meter counts changed frames plus suppressed ones. " +
    "Pixels are streamed as they arrive: this is a viewer for a remote terminal, not a " +
    "locally rendered game engine."],
];

const KITTY_KEYCODES: Record<string, number> = {
  Insert: 57348, Delete: 57349, PageUp: 57354, PageDown: 57355, Home: 57356, End: 57357,
  CapsLock: 57358, ScrollLock: 57359, NumLock: 57360, PrintScreen: 57361, Pause: 57362, Menu: 57363,
  Backspace: 127, Tab: 9, Enter: 13, Escape: 27, F13: 57376, F14: 57377, F15: 57378,
};
const ARROW_CODES: Record<string, string> = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D" };
/** CSI 15~, 17~..24~ for F5..F12; SS3 OP..OS for F1..F4. */
const FUNCTION_NUMBERS = [15, 17, 18, 19, 20, 21, 23, 24];

/**
 * Encode one key event for kitty-doom. eventType: 1 press, 2 repeat, 3 release.
 * Returns null for keys that carry no meaning for the game.
 */
export function kittyKeySequence(event: KeyboardEvent, eventType: 1 | 2 | 3): string | null {
  const { key, shiftKey, altKey, ctrlKey, metaKey } = event;
  if (!key || key === "Dead" || key === "Unidentified" || key === "Process") return null;
  const modifiers = 1 + (shiftKey ? 1 : 0) + (altKey ? 2 : 0) + (ctrlKey ? 4 : 0) + (metaKey ? 8 : 0);
  if (key in ARROW_CODES) {
    // kitty-doom schedules its own release for these.
    if (eventType !== 1) return null;
    return modifiers === 1 ? `\x1b[${ARROW_CODES[key]}` : `\x1b[1;${modifiers}${ARROW_CODES[key]}`;
  }
  const functionMatch = /^F([1-9]|1[0-2])$/.exec(key);
  if (functionMatch) {
    if (eventType === 3) return null;
    const index = Number(functionMatch[1]);
    if (index <= 4) return modifiers === 1 ? `\x1bO${"PQRS"[index - 1]}` : `\x1b[1;${modifiers}${"PQRS"[index - 1]}`;
    const code = FUNCTION_NUMBERS[index - 5];
    return modifiers === 1 ? `\x1b[${code}~` : `\x1b[${code};${modifiers}~`;
  }
  const codepoint = key.length === 1 ? key.codePointAt(0) : KITTY_KEYCODES[key];
  if (codepoint === undefined) return null;
  const suffix = modifiers === 1 && eventType === 1 ? "" : `;${modifiers}${eventType === 1 ? "" : `:${eventType}`}`;
  return `\x1b[${codepoint}${suffix}u`;
}

/** SGR 1006 mouse event in cell coordinates (1-based), as kitty-doom parses it. */
export function kittyMouseSequence(kind: "motion" | "press" | "release", button: number, cellX: number, cellY: number): string {
  const code = kind === "motion" ? button + 32 : button;
  const final = kind === "release" ? "m" : "M";
  return `\x1b[<${code};${cellX};${cellY}${final}`;
}

const clampCell = (value: number, limit: number) => Math.max(1, Math.min(limit, Math.floor(value) + 1));

export function mountKittyDoom(host: HTMLElement, token: () => string, _options: { paneId?: string; wad?: string } = {}): { dispose(): void } {
  let socket: WebSocket | null = null;
  let disposed = false;
  let program = _options.wad === "freedoom2" ? "freedoom2" : "freedoom1";
  let frames = 0;
  let unchanged = 0;
  let dropped = 0;
  let lastFrameAt = 0;
  let sampleAt = 0;
  let sampleFrames = 0;
  let pressedButtons = 0;
  let startedAt = 0;
  let totalBytes = 0;
  let totalChunks = 0;
  let maxChunks = 0;
  let chunksFrame = "";
  const formats = new Map<string, number>();
  const logLines: string[] = [];
  let pendingHeader: { format: string; width: number; height: number; chunks?: number } | null = null;

  const root = el("section", "kitty-doom-surface");
  const head = el("div", "kitty-doom-head");
  const title = el("h2", "", "Kitty DOOM");
  const programPicker = select(PROGRAMS, program, value => {
    program = value;
    if (socket) restart();
  });
  programPicker.setAttribute("aria-label", "Program");
  const startButton = button("Start", "Start the selected program in this window", () => start());
  const stopButton = button("Stop", "Stop the program and end its process", () => {
    closeSession();
    status.textContent = "Stopped. The process ended with the session.";
    render();
  });
  const fullButton = button("Fit", "Reset the canvas scale", () => resize());
  const saveButton = button("Save frame", "Download the frame currently on screen as a PNG", () => saveFrame());
  const reportButton = button("Copy report", "Copy a diagnostics report of this session", () => copyReport());
  head.append(title, programPicker, startButton, stopButton, fullButton, saveButton, reportButton);

  const status = el("p", "kitty-doom-status", "Not running. Connect the host, then press Start.");
  status.setAttribute("role", "status");
  const ready = el("p", "kitty-doom-ready", "");
  ready.setAttribute("role", "status");
  const stage = el("div", "kitty-doom-stage");
  const canvas = el("canvas", "kitty-doom-canvas");
  canvas.width = COLUMNS;
  canvas.height = ROWS;
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Kitty DOOM screen — click to focus, then use the arrow keys, Ctrl to fire and Space to open");
  const hint = el("p", "kitty-doom-hint", "Click the screen to focus it: arrows move/turn, Ctrl fire, Space open, Shift run, mouse looks and clicks. Escape opens the menu.");
  const meter = el("p", "kitty-doom-meter", "");
  const output = el("p", "kitty-doom-output", "");
  stage.append(canvas, hint);

  const info = el("details", "kitty-doom-info");
  const infoSummary = el("summary", "", "How this works — and why it is not a tmux pane");
  info.append(infoSummary);
  for (const [heading, body] of HOW_IT_WORKS) {
    const section = el("div", "kitty-doom-info-section");
    section.append(el("h4", "", heading), el("p", "", body));
    info.append(section);
  }

  const logHeading = el("h3", "kitty-doom-log-head", "Live events");
  const logView = el("div", "kitty-doom-log");
  logView.setAttribute("role", "log");
  logView.setAttribute("aria-live", "polite");

  root.append(head, status, ready, stage, meter, output, info, logHeading, logView);
  host.replaceChildren(root);

  function log(message: string) {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    logLines.push(`[${stamp}] ${message}`);
    if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
    logView.textContent = "";
    for (const line of logLines) logView.append(el("div", "kitty-doom-log-line", line));
    logView.scrollTop = logView.scrollHeight;
  }

  const screen = document.createElement("canvas");
  screen.width = COLUMNS;
  screen.height = ROWS;
  const screenContext = screen.getContext("2d")!;
  const image = screenContext.createImageData(COLUMNS, ROWS);
  const imageWords = new Uint32Array(image.data.buffer);
  const canvasContext = canvas.getContext("2d")!;
  canvasContext.imageSmoothingEnabled = false;

  function render() {
    startButton.disabled = !!socket;
    stopButton.disabled = !socket;
    programPicker.disabled = !!socket;
    saveButton.disabled = frames === 0;
    const state = token() ? "" : " Connect the host first.";
    startButton.title = `Start the selected program in this window.${state}`;
    const game = program === "freedoom1" || program === "freedoom2";
    hint.textContent = game
      ? "Click the screen to focus it: arrows move/turn, Ctrl fire, Space open, Shift run, mouse looks and clicks. Escape opens the menu."
      : "This program takes no keyboard input — it narrates what it sends on the wire in the log below, and draws into this canvas.";
  }

  function resize() {
    const bounds = stage.getBoundingClientRect();
    const width = bounds.width || COLUMNS;
    const height = bounds.height || ROWS;
    const scale = Math.max(1, Math.min(MAX_CANVAS_SCALE, Math.floor(Math.min((width - 8) / COLUMNS, (height - 8) / ROWS))));
    canvas.width = COLUMNS * scale;
    canvas.height = ROWS * scale;
    canvasContext.imageSmoothingEnabled = false;
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
  }

  function paintRgb(bytes: Uint8Array) {
    for (let index = 0, source = 0; index < imageWords.length; index += 1, source += 3)
      imageWords[index] = 0xff000000 | (bytes[source + 2] << 16) | (bytes[source + 1] << 8) | bytes[source];
    screenContext.putImageData(image, 0, 0);
    canvasContext.drawImage(screen, 0, 0, canvas.width, canvas.height);
  }

  function paintRgba(bytes: Uint8Array) {
    new Uint8Array(image.data.buffer).set(bytes);
    screenContext.putImageData(image, 0, 0);
    canvasContext.drawImage(screen, 0, 0, canvas.width, canvas.height);
  }

  function meterText() {
    const seconds = (performance.now() - sampleAt) / 1000;
    const fps = seconds > 0 ? sampleFrames / seconds : 0;
    const uptime = startedAt ? ` · up ${((performance.now() - startedAt) / 1000).toFixed(0)}s` : "";
    const formatList = [...formats.entries()].map(([kind, count]) => `${kind}×${count}`).join(" ");
    meter.textContent = socket
      ? `frame ${frames} · ${fps.toFixed(1)} changed frames/s · ${unchanged} identical redraws suppressed` +
        `${dropped ? ` · ${dropped} dropped` : ""} · ${(totalBytes / 1024).toFixed(0)} KiB in ${totalChunks} chunks` +
        `${maxChunks > 1 ? ` (up to ${maxChunks} per frame)` : ""}${formatList ? ` · ${formatList}` : ""}${uptime}`
      : "";
    sampleFrames = 0;
    sampleAt = performance.now();
  }

  /** A text report the owner can paste elsewhere; all values are measured here. */
  function reportText() {
    const seconds = startedAt ? (performance.now() - startedAt) / 1000 : 0;
    return [
      "Orbit Kitty DOOM pane — session report",
      `program: ${program}`,
      `socket: ${socket ? "open" : "closed"}`,
      `frames displayed: ${frames} (changed; identical redraws suppressed: ${unchanged}${dropped ? `, dropped: ${dropped}` : ""})`,
      `payload: ${totalBytes} bytes across ${totalChunks} APC chunks; most chunks in one frame: ${maxChunks}`,
      `formats decoded: ${[...formats.entries()].map(([kind, count]) => `${kind} x${count}`).join(", ") || "none yet"}`,
      `uptime: ${seconds.toFixed(1)}s`,
      `grid: ${COLUMNS}x${ROWS} cells; canvas ${canvas.width}x${canvas.height}px`,
    ].join("\n");
  }

  function saveFrame() {
    if (!frames) {
      status.textContent = "Nothing to save yet — start a program and wait for a frame.";
      return;
    }
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${program}-frame-${frames}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      log(`Saved frame ${frames} as ${link.download}.`);
    }, "image/png");
  }

  async function copyReport() {
    const text = reportText();
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Session report copied to the clipboard.";
      log("Copied the session report to the clipboard.");
    } catch {
      log(text.replace(/\n/g, " | "));
      status.textContent = "Clipboard unavailable — the report is in the log below.";
    }
  }

  function applyFrame(header: any, payload: ArrayBuffer) {
    frames = header.frames ?? frames + 1;
    unchanged = header.unchanged ?? unchanged;
    dropped = header.dropped ?? dropped;
    const bytes = new Uint8Array(payload, 0, header.bytes);
    const chunks = Number(header.chunks) || 1;
    totalBytes += header.bytes || 0;
    totalChunks += chunks;
    if (chunks > maxChunks) maxChunks = chunks;
    const kind = String(header.format || "unknown");
    const seen = formats.get(kind) || 0;
    formats.set(kind, seen + 1);
    if (!seen) {
      const detail = kind === "rgb" ? "RGB pixels (f=24)" : kind === "rgba" ? "RGBA pixels with alpha (f=32)"
        : kind === "png" ? "a PNG image (f=100)" : `${kind} data`;
      log(`First ${detail} decoded: ${header.width}x${header.height}, ${header.bytes} bytes in ${chunks} APC chunk${chunks === 1 ? "" : "s"}.`);
      render();
    } else if (chunks !== Number(chunksFrame)) {
      chunksFrame = String(chunks);
    }
    if (kind === "rgb") paintRgb(bytes);
    else if (kind === "rgba") paintRgba(bytes);
    else if (kind === "png") {
      const blob = new Blob([bytes.slice()], { type: "image/png" });
      void createImageBitmap(blob).then(bitmap => {
        if (disposed) return;
        screenContext.drawImage(bitmap, 0, 0, COLUMNS, ROWS);
        canvasContext.drawImage(screen, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      }).catch(() => {});
    }
    const now = performance.now();
    if (!sampleAt) sampleAt = now;
    sampleFrames += 1;
    if (now - lastFrameAt > 500) meterText();
    lastFrameAt = now;
  }

  function send(message: unknown) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function sendInput(data: string | null) {
    if (data) send({ type: "input", data });
  }

  function closeSession() {
    if (socket) {
      const current = socket;
      socket = null;
      current.onclose = null;
      try { current.close(); } catch { /* already closing */ }
      log("Session closed; the process on the host ended with it.");
    }
    pendingHeader = null;
    render();
  }

  function start() {
    if (!token()) {
      status.textContent = "Connect the host first (top bar) — the bridge requires the owner token.";
      return;
    }
    closeSession();
    pendingHeader = null;
    frames = 0;
    unchanged = 0;
    dropped = 0;
    totalBytes = 0;
    totalChunks = 0;
    maxChunks = 0;
    chunksFrame = "";
    formats.clear();
    ready.textContent = "";
    startedAt = performance.now();
    status.textContent = "Starting…";
    const label = PROGRAMS.find(([key]) => key === program)?.[1] || program;
    log(`Starting "${label}" — one PTY, one websocket.`);
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/kitty-doom`;
    const current = new WebSocket(url);
    current.binaryType = "arraybuffer";
    socket = current;
    current.onopen = () => {
      log("Websocket open; presenting the owner token and the terminal geometry.");
      current.send(JSON.stringify({ type: "auth", token: token(), cols: COLUMNS, rows: ROWS, program }));
    };
    current.onmessage = event => {
      if (typeof event.data !== "string") {
        if (!pendingHeader) return;
        const header = pendingHeader;
        pendingHeader = null;
        applyFrame(header, event.data as ArrayBuffer);
        return;
      }
      let message: any;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "ready") {
        ready.textContent = `Running ${message.title || program} at ${message.columns}x${message.rows} cells. Closing this window ends the process.`;
        log(`Ready: ${message.title || program} is running in a PTY at ${message.columns}x${message.rows} cells (bridge protocol ${message.protocol}).`);
        resize();
      } else if (message.type === "frame") {
        pendingHeader = message;
      } else if (message.type === "exit") {
        status.textContent = `${message.title || program} exited (code ${message.code}). Press Start to run it again.`;
        log(`The program exited with code ${message.code}.`);
        closeSession();
      } else if (message.type === "error") {
        status.textContent = message.message;
        log(`Error: ${message.message}`);
      } else if (message.type === "notice") {
        log(message.message);
      } else if (message.type === "output") {
        const text = String(message.message || "").replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b/gu, "").trim();
        if (text) {
          output.textContent = text.slice(0, 300);
          log(`program stdout: ${text.slice(0, 200)}`);
        }
      }
    };
    current.onclose = () => {
      if (socket !== current) return;
      socket = null;
      if (!disposed) {
        status.textContent = "Session closed. The process ended with it.";
        log("Websocket closed.");
      }
      render();
    };
    current.onerror = () => {
      if (socket === current) status.textContent = "The bridge websocket failed. Is the bridge route running on this server?";
      log("Websocket error — the bridge route may not be running on this server.");
    };
    render();
  }

  function restart() {
    const wasRunning = !!socket;
    closeSession();
    if (wasRunning) start();
  }

  function keyHandler(event: KeyboardEvent, type: 1 | 2 | 3) {
    const sequence = kittyKeySequence(event, type);
    if (!sequence) return;
    event.preventDefault();
    event.stopPropagation();
    sendInput(sequence);
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "F11") return;
    keyHandler(event, event.repeat ? 2 : 1);
  };
  const onKeyUp = (event: KeyboardEvent) => keyHandler(event, 3);
  const onBlur = () => { pressedButtons = 0; };
  const cell = (event: MouseEvent) => {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: clampCell(((event.clientX - bounds.left) / Math.max(1, bounds.width)) * COLUMNS, COLUMNS),
      y: clampCell(((event.clientY - bounds.top) / Math.max(1, bounds.height)) * ROWS, ROWS),
    };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!socket) return;
    const { x, y } = cell(event);
    sendInput(kittyMouseSequence("motion", pressedButtons ? buttonBit(event.buttons) : 3, x, y));
  };
  const onPointerDown = (event: PointerEvent) => {
    canvas.focus();
    if (!socket) return;
    const bit = buttonBit(event.buttons);
    pressedButtons = bit;
    const { x, y } = cell(event);
    sendInput(kittyMouseSequence("press", bit, x, y));
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!socket) return;
    const bit = pressedButtons || buttonBit(event.buttons);
    pressedButtons = 0;
    const { x, y } = cell(event);
    sendInput(kittyMouseSequence("release", bit, x, y));
  };
  const buttonBit = (buttons: number) => (buttons & 2 ? 2 : buttons & 4 ? 1 : 0);

  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("blur", onBlur);
  canvas.addEventListener("contextmenu", event => event.preventDefault());
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => resize());
  observer?.observe(stage);

  render();
  resize();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      closeSession();
      root.remove();
    },
  };
}
