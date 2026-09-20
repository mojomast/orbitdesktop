import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { el, button, select } from "./dom";
import { createAgentChat } from "./agent-chat";
import type { Pane, PaneKind } from "./model";
export interface PaneView {
  element: HTMLElement;
  resize: () => void;
  setFont: (n: number) => void;
  dispose: () => void;
}
export interface PaneActions {
  kind: (id: string, kind: PaneKind) => void;
  split: (id: string, axis: "row" | "column") => void;
  close: (id: string) => void;
  url: (id: string, url: string) => void;
}
export let sessionToken = "";
export function setToken(t: string) {
  sessionToken = t;
  window.dispatchEvent(new Event('orbit-host-connected'));
}
export function createPane(p: Pane, font: number, a: PaneActions): PaneView {
  const root = el("section", "pane");
  root.dataset.paneId = p.id;
  const head = el("div", "pane-head");
  const type = select(
    [
      ["terminal", "Terminal"],
      ["browser", "Browser"],
      ["agent", "Agent chat"],
    ],
    p.kind,
    (v) => a.kind(p.id, v as PaneKind),
  );
  type.setAttribute("aria-label", "Pane type");
  head.append(
    type,
    el("span", "pane-spacer"),
    button("◫", "Split pane side by side", () => a.split(p.id, "row")),
    button("⬒", "Split pane top and bottom", () => a.split(p.id, "column")),
    button("×", "Close pane", () => a.close(p.id)),
  );
  const body = el("div", "pane-body");
  root.append(head, body);
  let cleanup = () => {},
    resize = () => {},
    setFont = (n: number) => {
      body.style.fontSize = `${n}px`;
    };
  body.style.fontSize = `${font}px`;
  if (p.kind === "terminal") {
    const bar = el("div", "terminal-bar");
    const status = el("span", "connection-state", "DISCONNECTED");
    let ws: WebSocket | null = null,
      disposed = false;
    const connect = button(
      "Connect shell",
      "Connect to local host shell",
      () => open(),
      "small-button",
    );
    bar.append(status, connect);
    body.append(bar);
    const host = el("div", "terminal-host");
    body.append(host);
    const term = new Terminal({
      fontSize: font,
      fontFamily: '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
      cursorBlink: true,
      scrollback: 3000,
      theme: {
        background: "#10191e",
        foreground: "#d5e2df",
        cursor: "#c2ed90",
        selectionBackground: "#41544d",
        green: "#c2ed90",
        cyan: "#86cccb",
      },
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.writeln("\x1b[38;2;194;237;144mORBIT / LOCAL TERMINAL\x1b[0m\r\n");
    term.writeln("A real shell on the machine running Orbit.\r\n");
    term.writeln(
      "1. Start the included local server.\r\n2. Unlock host access with its session token.\r\n3. Select Connect shell.\r\n",
    );
    term.writeln("\x1b[90mNo shell is running in this pane yet.\x1b[0m");
    const send = (v: unknown) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(v));
    };
    function open() {
      if (
        ws &&
        (ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING)
      )
        return;
      if (!sessionToken) {
        term.writeln(
          "\r\n\x1b[33mUse “Connect host” in the top bar first.\x1b[0m",
        );
        return;
      }
      status.textContent = "CONNECTING";
      connect.disabled = true;
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal`,
      );
      ws = socket;
      socket.onopen = () => {
        fit.fit();
        send({
          type: "auth",
          pane_id: p.id,
          token: sessionToken,
          cols: term.cols,
          rows: term.rows,
        });
      };
      socket.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.type === "ready") {
          term.clear();
          status.textContent = `LIVE SHELL · ${m.user || 'host'}`;
          term.writeln(`Connected to ${m.user || 'user'}@${m.host || 'host'} — ${m.cwd || ''}\r\n`);
          status.classList.add("live");
          connect.textContent = "Connected";
        }
        if (m.type === "data")
          term.write(m.data, () =>
            send({ type: "ack", length: m.data.length }),
          );
        if (m.type === "error") term.writeln(`\r\n${m.message}`);
        if (m.type === "exit") term.writeln(`\r\n[Shell exited: ${m.code}]`);
      };
      socket.onerror = () => {
        status.textContent = "UNAVAILABLE";
      };
      socket.onclose = () => {
        if (disposed) return;
        status.textContent = "DISCONNECTED";
        status.classList.remove("live");
        connect.disabled = false;
        connect.textContent = "Reconnect";
        term.writeln(
          "\r\n\x1b[90mConnection closed. Reconnect resumes this pane’s persistent shell.\x1b[0m",
        );
      };
    }
    term.onData((data) => send({ type: "input", data }));
    term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    resize = () => {
      try {
        if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
      } catch {
        /* detached during focus transitions */
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    setFont = (n) => {
      term.options.fontSize = n;
      resize();
    };
    cleanup = () => {
      disposed = true;
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
  } else if (p.kind === "browser") {
    body.classList.add("browser-body");
    const nav = el("form", "browser-nav");
    const address = el("input");
    address.value = p.url;
    address.setAttribute("aria-label", "Browser address");
    address.placeholder = "https://example.com";
    let current = p.url;
    const surface = el("div", "browser-surface");
    let frame: HTMLIFrameElement | null = null;
    let browserFont = font;
    const zoomFrame = () => {
      if (!frame) return;
      const zoom = browserFont / 19;
      frame.style.position = "absolute";
      frame.style.left = "0";
      frame.style.top = "0";
      frame.style.transformOrigin = "top left";
      frame.style.width = `${100 / zoom}%`;
      frame.style.height = `calc((100% - 38px) / ${zoom})`;
      frame.style.transform = `scale(${zoom})`;
    };
    function navigate(raw: string) {
      let url = raw.trim();
      if (url === "orbit://welcome") {
        current = url;
        a.url(p.id, url);
        address.value = url;
        surface.replaceChildren();
        frame = null;
        const welcome = el("div", "welcome");
        welcome.append(
          el("div", "eyebrow", "YOUR SPACE, IN EVERY DIMENSION"),
          el("h1", "", "Room to think."),
          el("p", "", "One workspace. As many perspectives as you need."),
        );
        const cards = el("div", "welcome-cards");
        for (const [n, t, d] of [
          [
            "01",
            "Make it yours",
            "Select a display, then adjust its shape and position.",
          ],
          [
            "02",
            "Divide your attention",
            "Split any pane into terminals, browsers, and agents.",
          ],
          [
            "03",
            "Get closer",
            "Use Focus for a full-size, distraction-free display.",
          ],
        ]) {
          const c = el("div", "welcome-card");
          c.append(
            el("span", "card-number", n),
            el("strong", "", t),
            el("p", "", d),
          );
          cards.append(c);
        }
        welcome.append(
          cards,
          el("div", "welcome-foot", "ORBIT  /  WORKSPACE GUIDE"),
        );
        surface.append(welcome);
        return;
      }
      try {
        if (url.startsWith('/apps/')) url = new URL(url, location.origin).href;
        else if (!/^https?:\/\//i.test(url)) url = "https://" + url;
        const u = new URL(url);
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password
        )
          throw Error();
        const localApp = u.origin === location.origin && /^\/apps\/[a-z0-9][a-z0-9-]{0,60}\//.test(u.pathname);
        if (u.origin === location.origin && !localApp)
          throw Error("The Orbit host cannot be embedded.");
        current = u.href;
        address.value = current;
        a.url(p.id, localApp ? u.pathname + u.search + u.hash : current);
        frame = el("iframe");
        frame.title = "Embedded browser";
        frame.referrerPolicy = "no-referrer";
        frame.setAttribute(
          "sandbox",
          localApp ? "allow-scripts allow-forms allow-modals allow-downloads" : "allow-scripts allow-forms allow-same-origin allow-popups",
        );
        frame.src = current;
        surface.replaceChildren(frame);
        const note = el(
          "div",
          "embed-note",
          "Some sites block embedding. Use ↗ to open them in a new tab.",
        );
        surface.append(note);
        zoomFrame();
      } catch (e) {
        surface.replaceChildren(
          el(
            "p",
            "browser-error",
            e instanceof Error && e.message
              ? e.message
              : "Enter a valid HTTP or HTTPS address.",
          ),
        );
      }
    }
    nav.append(
      button("⌂", "Browser home", () => navigate("orbit://welcome")),
      address,
      button("↻", "Reload page", () => navigate(current)),
      button("↗", "Open browser page in new tab", () => {
        if (/^https?:/.test(current))
          window.open(current, "_blank", "noopener,noreferrer");
      }),
    );
    nav.onsubmit = (e) => {
      e.preventDefault();
      navigate(address.value);
    };
    body.append(nav, surface);
    navigate(current);
    setFont = (n) => {
      browserFont = n;
      body.style.fontSize = `${n}px`;
      zoomFrame();
    };
  } else {
    cleanup = createAgentChat(body, p.id, () => sessionToken);
  }
  return { element: root, resize, setFont, dispose: cleanup };
}
