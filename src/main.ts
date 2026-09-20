import "./style.css";
import "./windows.css";
import { el, button, select } from "./dom";
import {
  load,
  monitor,
  leaves,
  replace,
  remove,
  pane,
  validate,
  type Monitor,
  type Layout,
  type PaneKind,
} from "./model";
import { createPane, setToken, sessionToken, type PaneView } from "./panes";
import { placeWindow, wireWindow } from "./windows";
import { connectWorkspace } from "./workspace-sync";
import { DesktopScene } from "./scene";
let state = load();
state.view ||= 'windows';
let applyingRemote = false;
let workspaceBridge: ReturnType<typeof connectWorkspace> | undefined;
const views = new Map<string, PaneView>();
const monitors = new Map<string, HTMLElement>();
let focused: string | null = null;
let saveTimer: ReturnType<typeof setTimeout>;
const app = document.querySelector<HTMLDivElement>("#app")!;
const top = el("header", "topbar");
const brand = el("div", "brand");
brand.append(
  el("span", "brand-mark", "◉"),
  el("strong", "", "orbit"),
  el("span", "brand-tag", "SPATIAL DESKTOP"),
);
const hostStatus = button(
  "↗  Connect host",
  "Connect local host",
  () => connectHost(),
  "host-button",
);
const saved = el("span", "saved", "Saved locally");
const sidebarToggle = button('Hide panel', 'Toggle side panel', () => { state.sidebarHidden = !state.sidebarHidden; applySidebar(); save(); });
top.append(brand, saved, sidebarToggle, hostStatus);
const shell = el("main", "shell"),
  work = el("section", "workspace"),
  stage = el("div", "stage");
stage.setAttribute("aria-label", "3D monitor workspace");
const sub = el("div", "workspace-heading");
const title = el("div");
title.append(
  el("span", "eyebrow", "WORKSPACE / 01"),
  el("h1", "", "Your command center"),
);
const mode = el("div", "mode-switch");
const sceneButton = button(
    "◈  Spatial",
    "Switch to spatial view",
    () => setView('spatial'),
    "active",
  ),
  flatButton = button("▣  Focus", "Focus selected display", () =>
    focus(state.selected),
  );
const windowsButton = button('▤ Windows', 'Switch to movable windows', () => setView('windows'));
mode.append(windowsButton, sceneButton, flatButton);
sub.append(title, mode);
const guide = el(
  "div",
  "scene-guide",
  "Drag empty space to orbit · Scroll to zoom · Alt + drag anywhere",
);
const navigation = el("div", "scene-navigation");
const navDisplays = el("div", "display-tabs");
navigation.append(
  navDisplays,
  el("div", "nav-divider"),
  button("−", "Zoom out", () => scene.zoom(0.12)),
  button("⌖", "Reset camera", () => scene.reset()),
  button("+", "Zoom in", () => scene.zoom(-0.12)),
);
const focusHost = el("div", "focus-host");
const desktopHost = el('div', 'desktop-host');
desktopHost.setAttribute('aria-label', 'Movable workspace windows');
const focusBack = button(
  "←  Back to spatial view",
  "Exit focus view",
  () => unfocus(),
  "focus-back",
);
focusHost.append(focusBack);
work.append(sub, stage, desktopHost, guide, navigation, focusHost);
const inspector = el("aside", "inspector");
work.classList.toggle('windows-mode', state.view === 'windows');
shell.append(work, inspector);
const footer = el("footer", "footer");
footer.append(
  el("span", "", "ORBIT / LOCAL WORKSPACE"),
  el("span", "footer-status", "3D + DOM · v0.1 foundation"),
);
app.append(top, shell, footer);
const scene = new DesktopScene(stage);
if (stage.classList.contains("no-webgl"))
  footer.querySelector(".footer-status")!.textContent =
    "CSS3D mode · WebGL unavailable";
const toast = el("div", "toast");
toast.role = "status";
app.append(toast);
let toastTimer: ReturnType<typeof setTimeout>;
function notify(s: string) {
  toast.textContent = s;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}
function save() {
  if (!applyingRemote) workspaceBridge?.changed();
  clearTimeout(saveTimer);
  saved.textContent = "Saving…";
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem("orbit.workspace.v1", JSON.stringify(state));
      saved.textContent = "Saved locally";
    } catch {
      saved.textContent = "Storage unavailable";
    }
  }, 200);
}
function current(): Monitor {
  return state.monitors.find((m) => m.id === state.selected)!;
}
function choose(id: string) {
  state.selected = id;
  const chosen = state.monitors.find(m => m.id === id);
  if (chosen?.frame && state.view === 'windows') chosen.frame.z = Math.min(99999, Math.max(...state.monitors.map(m => m.frame?.z || 0)) + 1);
  renderInspector();
  updateScene();
  renderTabs();
  save();
}
function updateScene() {
  if (state.monitors.some((m) => !monitors.has(m.id))) return;
  for (const m of state.monitors) {
    const meta = monitors.get(m.id)?.querySelector(".monitor-meta");
    if (meta) meta.textContent = `${m.diagonal}″ / ${m.aspect}`;
  }
  if (state.view === 'windows') {
    state.monitors.forEach((m, i) => {
      const element = monitors.get(m.id)!;
      element.classList.toggle('selected', m.id === state.selected);
      if (focused !== m.id) {
        if (element.parentElement !== desktopHost) desktopHost.append(element);
        element.classList.add('desktop-window');
        placeWindow(element, m, desktopHost, i);
      }
    });
  } else scene.update(state.monitors, monitors, state.selected, state.arc);
  views.forEach((v) => v.resize());
}
function renderTabs() {
  navDisplays.replaceChildren();
  state.monitors.forEach((m, i) => {
    const b = button(
      `${String(i + 1).padStart(2, "0")}  ${m.name}`,
      `Select ${m.name}`,
      () => {
        if (focused) focus(m.id);
        else choose(m.id);
      },
      m.id === state.selected ? "selected" : "",
    );
    navDisplays.append(b);
  });
}
function focus(id: string) {
  if (focused) unfocus();
  choose(id);
  focused = id;
  const element = monitors.get(id)!;
  element.classList.remove('desktop-window');
  for (const key of ['left', 'top', 'width', 'height', 'z-index']) element.style.removeProperty(key);
  focusHost.append(element);
  focusHost.classList.add("visible");
  work.classList.add("is-focused");
  sceneButton.classList.remove("active");
  flatButton.classList.add("active");
  element.classList.add("flat-monitor");
  element.style.transform = "none";
  views.forEach((v) => v.resize());
}
function unfocus() {
  if (!focused) return;
  const element = monitors.get(focused);
  element?.classList.remove("flat-monitor");
  if (element) {
    if (state.view === 'windows') desktopHost.append(element);
    else { const anchor = stage.querySelector(`[data-anchor-id="${focused}"]`); anchor?.append(element); }
  }
  focused = null;
  focusHost.classList.remove("visible");
  work.classList.remove("is-focused");
  sceneButton.classList.add("active");
  flatButton.classList.remove("active");
  updateScene();
}
function applySidebar() {
  shell.classList.toggle('sidebar-hidden', !!state.sidebarHidden);
  sidebarToggle.textContent = state.sidebarHidden ? 'Show panel' : 'Hide panel';
  sidebarToggle.setAttribute('aria-expanded', String(!state.sidebarHidden));
  requestAnimationFrame(() => { scene.resize(); updateScene(); });
}
function setView(view: 'windows' | 'spatial') {
  unfocus(); state.view = view;
  work.classList.toggle('windows-mode', view === 'windows');
  windowsButton.classList.toggle('active', view === 'windows');
  sceneButton.classList.toggle('active', view === 'spatial');
  if (view === 'spatial') {
    monitors.forEach((element, id) => {
      element.classList.remove('desktop-window');
      for (const key of ['left', 'top', 'width', 'height', 'z-index']) element.style.removeProperty(key);
      stage.querySelector(`[data-anchor-id="${id}"]`)?.append(element);
    });
    scene.update(state.monitors, monitors, state.selected, state.arc);
  }
  updateScene(); save();
}
function confirmChange(text: string, action: () => void) {
  const d = el("dialog", "dialog");
  d.append(el("h2", "", "Change workspace?"), el("p", "", text));
  const row = el("div", "dialog-actions");
  row.append(
    button("Cancel", "Cancel change", () => d.close()),
    button(
      "Continue",
      "Confirm change",
      () => {
        d.close();
        action();
      },
      "primary",
    ),
  );
  d.append(row);
  d.onclose = () => d.remove();
  app.append(d);
  d.showModal();
}
function renderLayout(layout: Layout, m: Monitor): HTMLElement {
  if (layout.type === "pane") {
    let v = views.get(layout.pane.id);
    if (!v) {
      v = createPane(layout.pane, m.fontSize, {
        kind: (id, kind) => {
          confirmChange(
            "Switching this pane closes its current session.",
            () => {
              views.get(id)?.dispose();
              views.delete(id);
              m.layout = replace(m.layout, id, (p) => ({
                type: "pane",
                pane: { ...p, kind },
              }));
              renderMonitor(m);
              save();
            },
          );
        },
        split: (id, axis) => {
          if (leaves(m.layout).length >= 8) {
            notify("Maximum 8 panes per display");
            return;
          }
          m.layout = replace(m.layout, id, (p) => ({
            type: "split",
            axis,
            ratio: 0.5,
            first: { type: "pane", pane: p },
            second: pane("terminal"),
          }));
          renderMonitor(m);
          save();
        },
        close: (id) => {
          if (leaves(m.layout).length === 1) {
            notify("Keep at least one pane on each display");
            return;
          }
          confirmChange(
            "Closing this pane ends its shell or clears its chat.",
            () => {
              m.layout = remove(m.layout, id)!;
              views.get(id)?.dispose();
              views.delete(id);
              renderMonitor(m);
              save();
            },
          );
        },
        url: (id, url) => {
          const p = leaves(m.layout).find((p) => p.id === id);
          if (p) {
            p.url = url;
            save();
          }
        },
      });
      views.set(layout.pane.id, v);
    }
    return v.element;
  }
  const split = el("div", `split ${layout.axis}`);
  const first = el("div", "split-child"),
    second = el("div", "split-child");
  first.style.flex = `${layout.ratio} 1 0`;
  second.style.flex = `${1 - layout.ratio} 1 0`;
  first.append(renderLayout(layout.first, m));
  second.append(renderLayout(layout.second, m));
  const divider = el("div", "split-divider");
  divider.tabIndex = 0;
  divider.role = "separator";
  divider.setAttribute("aria-label", "Resize split");
  divider.setAttribute(
    "aria-orientation",
    layout.axis === "row" ? "vertical" : "horizontal",
  );
  const set = (ratio: number) => {
    layout.ratio = Math.max(0.15, Math.min(0.85, ratio));
    first.style.flex = `${layout.ratio} 1 0`;
    second.style.flex = `${1 - layout.ratio} 1 0`;
    divider.setAttribute(
      "aria-valuenow",
      String(Math.round(layout.ratio * 100)),
    );
    save();
  };
  let dragging = false;
  divider.onpointerdown = (e) => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  divider.onpointermove = (e) => {
    if (!dragging) return;
    const r = split.getBoundingClientRect();
    set(
      layout.axis === "row"
        ? (e.clientX - r.left) / r.width
        : (e.clientY - r.top) / r.height,
    );
  };
  divider.onpointerup = () => (dragging = false);
  divider.onpointercancel = () => (dragging = false);
  divider.onkeydown = (e) => {
    if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      set(
        layout.ratio +
          (["ArrowLeft", "ArrowUp"].includes(e.key) ? -0.05 : 0.05),
      );
    }
  };
  split.append(first, divider, second);
  return split;
}
function renderMonitor(m: Monitor) {
  let outer = monitors.get(m.id);
  if (!outer) {
    outer = el("article", "monitor");
    outer.dataset.monitorId = m.id;
    outer.addEventListener("pointerdown", () => {
      if (state.selected !== m.id) choose(m.id);
    }, true);
    monitors.set(m.id, outer);
  }
  const bar = el("div", "monitor-bar");
  bar.append(
    el("span", "monitor-indicator"),
    el("strong", "", m.name),
    el("span", "monitor-meta", `${m.diagonal}″ / ${m.aspect}`),
    el("span", "pane-spacer"),
    button("A−", `Decrease text size on ${m.name}`, () => font(m, -1)),
    button("A+", `Increase text size on ${m.name}`, () => font(m, 1)),
    button("⚙", `Settings for ${m.name}`, () => choose(m.id)),
    button("⛶", `Focus ${m.name}`, () => focus(m.id)),
    button('×', `Close ${m.name}`, () => { choose(m.id); deleteMonitor(); }),
  );
  const content = el("div", "monitor-content");
  content.append(renderLayout(m.layout, m));
  const resizeHandle = el('div', 'window-resize', '◢');
  outer.replaceChildren(bar, content, resizeHandle);
  wireWindow(outer, bar, resizeHandle, m, desktopHost, () => state.view === 'windows' && !focused, () => { renderInspector(); views.forEach(v => v.resize()); save(); });
  updateScene();
  if (focused === m.id) {
    focusHost.append(outer);
    outer.classList.add("flat-monitor");
    outer.style.transform = "none";
  }
}
function font(m: Monitor, delta: number) {
  m.fontSize = Math.max(12, Math.min(32, m.fontSize + delta));
  leaves(m.layout).forEach((p) => views.get(p.id)?.setFont(m.fontSize));
  renderInspector();
  save();
}
function range(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  on: (v: number) => void,
) {
  const wrap = el("label", "field");
  const line = el("div", "field-line"),
    output = el("output", "", `${value}${unit}`);
  line.append(el("span", "", label), output);
  const input = el("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute("aria-label", label);
  input.oninput = () => {
    output.value = `${input.value}${unit}`;
    on(Number(input.value));
    save();
  };
  wrap.append(line, input);
  return wrap;
}
function renderInspector() {
  const m = current();
  inspector.replaceChildren();
  const head = el("div", "inspector-head");
  head.append(
    el("div", "eyebrow", "DISPLAY CONFIGURATION"),
    el("h2", "", m.name),
  );
  const name = el("input", "name-input");
  name.value = m.name;
  name.maxLength = 60;
  name.setAttribute("aria-label", "Display name");
  name.onchange = () => {
    m.name = name.value.trim() || "Display";
    renderMonitor(m);
    renderInspector();
    renderTabs();
    save();
  };
  head.append(name);
  inspector.append(head);
  const preset = el("div", "settings-section");
  preset.append(el("h3", "", "WORKSPACE"));
  const count = el("div", "count-control");
  count.append(
    button("−", "Remove selected monitor", () => deleteMonitor()),
    el("span", "", `${state.monitors.length} displays`),
    button("+", "Add monitor", () => addMonitor()),
  );
  preset.append(count);
  const presets = select(
    [
      ["custom", "Layout presets…"],
      ["single", "Single / deep focus"],
      ["dual", "Dual / side by side"],
      ["triple", "Triple / command center"],
    ],
    "custom",
    (v) => {
      if (v === "custom") return;
      confirmChange(
        "Applying a preset replaces the workspace and closes existing shells.",
        () => {
          unfocus();
          views.forEach((v) => v.dispose());
          views.clear();
          monitors.clear();
          const n = v === "single" ? 1 : v === "dual" ? 2 : 3;
          state.monitors = Array.from({ length: n }, (_, i) =>
            monitor(i + 1, (["terminal", "browser", "agent"] as PaneKind[])[i]),
          );
          state.selected = state.monitors[0].id;
          renderAll();
        },
      );
    },
  );
  presets.setAttribute("aria-label", "Layout preset");
  preset.append(
    presets,
    range("Wrap angle", state.arc, 0, 30, 1, "°", (v) => {
      state.arc = v;
      updateScene();
    }),
  );
  inspector.append(preset);
  const display = el("div", "settings-section");
  display.append(el("h3", "", "SHAPE & SCALE"));
  const ratioLabel = el("label", "field");
  ratioLabel.append(el("span", "", "Aspect ratio"));
  const ratios = select(
    ["16:9", "16:10", "21:9", "32:9", "4:3", "9:16", "1:1"].map((v) => [v, v]),
    m.aspect,
    (v) => {
      m.aspect = v;
      renderMonitor(m);
      save();
    },
  );
  ratios.setAttribute("aria-label", "Aspect ratio");
  ratioLabel.append(ratios);
  display.append(
    ratioLabel,
    range("Diagonal", m.diagonal, 20, 55, 1, "″", (v) => {
      m.diagonal = v;
      updateScene();
    }),
    range("Text size", m.fontSize, 12, 32, 1, " px", (v) => {
      m.fontSize = v;
      leaves(m.layout).forEach((p) => views.get(p.id)?.setFont(v));
    }),
  );
  inspector.append(display);
  const position = el("div", "settings-section");
  position.append(el("h3", "", "POSITION"));
  for (const [label, key, min, max, step, unit] of [
    ["Height", "height", -2, 3, 0.1, " u"],
    ["Distance", "distance", -2, 4, 0.1, " u"],
    ["Pitch", "pitch", -35, 35, 1, "°"],
    ["Yaw", "yaw", -45, 45, 1, "°"],
    ["Horizontal offset", "offset", -3, 3, 0.1, " u"],
  ] as const) {
    position.append(
      range(label, m[key], min, max, step, unit, (v) => {
        m[key] = v;
        updateScene();
      }),
    );
  }
  inspector.append(position);
  const actions = el("div", "settings-section settings-actions");
  actions.append(
    button("↧  Export layout", "Export workspace layout", exportLayout),
    button("↥  Import layout", "Import workspace layout", () =>
      importInput.click(),
    ),
  );
  const note = el(
    "p",
    "inspector-note",
    "Layouts save in this browser. Shell sessions end when their pane closes.",
  );
  actions.append(note);
  inspector.append(actions);
}
function addMonitor() {
  if (state.monitors.length >= 8) {
    notify("Maximum 8 displays");
    return;
  }
  const m = monitor(state.monitors.length + 1);
  state.monitors.push(m);
  state.selected = m.id;
  renderMonitor(m);
  renderInspector();
  renderTabs();
  save();
}
function deleteMonitor() {
  if (state.monitors.length === 1) {
    notify("Keep at least one display");
    return;
  }
  const m = current();
  confirmChange(`Remove ${m.name} and close all its panes?`, () => {
    unfocus();
    leaves(m.layout).forEach((p) => {
      views.get(p.id)?.dispose();
      views.delete(p.id);
    });
    monitors.delete(m.id);
    state.monitors = state.monitors.filter((x) => x.id !== m.id);
    state.selected = state.monitors[0].id;
    renderAll();
  });
}
function renderAll() {
  desktopHost.querySelectorAll<HTMLElement>('[data-monitor-id]').forEach(element => { if (!state.monitors.some(m => m.id === element.dataset.monitorId)) element.remove(); });
  state.monitors.forEach(renderMonitor);
  renderInspector();
  renderTabs();
  updateScene();
  applySidebar();
  save();
}
function exportLayout() {
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob),
    a = el("a");
  a.href = url;
  a.download = "orbit-workspace.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("Workspace exported. Credentials and terminal data are excluded.");
}
const importInput = el("input");
importInput.type = "file";
importInput.accept = ".json,application/json";
importInput.hidden = true;
app.append(importInput);
importInput.onchange = async () => {
  const f = importInput.files?.[0];
  if (!f) return;
  try {
    if (f.size > 100000) throw Error("Layout file is too large");
    const next = validate(JSON.parse(await f.text()));
    confirmChange(
      "Importing replaces this layout and closes current shells.",
      () => {
        unfocus();
        views.forEach((v) => v.dispose());
        views.clear();
        monitors.clear();
        state = next;
        renderAll();
      },
    );
  } catch (e) {
    notify(e instanceof Error ? e.message : "Invalid layout");
  }
  importInput.value = "";
};
function connectHost() {
  const d = el("dialog", "dialog");
  d.append(
    el("div", "eyebrow", "PRIVATE WORKSPACE"),
    el("h2", "", "Unlock terminals and Hermes"),
    el(
      "p",
      "",
      "Paste your Orbit session token. This unlocks terminal access and the connected Hermes agent, which can use tools in its own host environment.",
    ),
  );
  const code = el("p", "muted", "Keep this token private. It stays in browser memory and must be entered again after a reload.");
  const input = el("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "Session token";
  input.setAttribute("aria-label", "Host session token");
  const msg = el("p", "connection-message");
  const row = el("div", "dialog-actions");
  const unlock = button(
    "Unlock host",
    "Unlock local host",
    async () => {
      unlock.disabled = true;
      try {
        const r = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: input.value }),
        });
        if (!r.ok)
          throw Error(
            r.status === 401
              ? "That token was not accepted."
              : "Orbit server unavailable. Check your connection and try again.",
          );
        setToken(input.value);
        input.value = "";
        hostStatus.textContent = "●  Host unlocked";
        d.close();
        notify("Unlocked. Chat with Hermes or select Connect shell.");
      } catch (e) {
        msg.textContent =
          e instanceof Error ? e.message : "Unable to reach local server";
      } finally {
        unlock.disabled = false;
      }
    },
    "primary",
  );
  row.append(
    button("Cancel", "Close host dialog", () => d.close()),
    unlock,
  );
  d.append(code, input, msg, row);
  d.onclose = () => d.remove();
  app.append(d);
  d.showModal();
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && focused) unfocus();
});
new ResizeObserver(() => updateScene()).observe(stage);
window.addEventListener("beforeunload", () => {
  try {
    localStorage.setItem("orbit.workspace.v1", JSON.stringify(state));
  } catch {}
  views.forEach((v) => v.dispose());
  scene.dispose();
});
workspaceBridge = connectWorkspace(() => state, next => {
  applyingRemote = true;
  try {
    const valid = validate(next);
    const previousFocus = focused;
    if (focused) unfocus();
    const nextPanes = new Map(valid.monitors.flatMap(m => leaves(m.layout).map(p => [p.id, { p, monitorId: m.id }] as const)));
    for (const m of state.monitors) for (const p of leaves(m.layout)) {
      const match = nextPanes.get(p.id);
      if (!match || match.monitorId !== m.id || match.p.kind !== p.kind || match.p.url !== p.url) { views.get(p.id)?.dispose(); views.delete(p.id); }
    }
    for (const [id, element] of monitors) if (!valid.monitors.some(m => m.id === id)) { element.remove(); monitors.delete(id); }
    valid.monitors = valid.monitors.map(m => { const old = state.monitors.find(x => x.id === m.id); return old ? Object.assign(old, m) : m; });
    state = valid; state.view ||= 'windows';
    renderAll(); setView(state.view); choose(state.selected);
    if (previousFocus && state.monitors.some(m => m.id === previousFocus) && state.selected === previousFocus) focus(previousFocus);
  } finally { applyingRemote = false; }
}, () => sessionToken, message => { saved.textContent = message; });
renderAll();
setView(state.view || 'windows');
// Optional, page-scoped WebMCP: no terminal input or credentials are exposed.
const modelContext = (
  document as Document & {
    modelContext?: {
      registerTool: (
        tool: unknown,
        options: { signal: AbortSignal },
      ) => void | Promise<void>;
    };
  }
).modelContext;
if (modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const register = (tool: unknown) => {
    try {
      Promise.resolve(
        modelContext.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {}
  };
  register({
    name: "read_display_layout",
    description:
      "Read monitor geometry and pane types. Does not include chat or terminal content.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: () => ({
      selected: state.selected,
      monitors: state.monitors.map((m) => ({
        id: m.id,
        name: m.name,
        aspect: m.aspect,
        diagonal: m.diagonal,
        height: m.height,
        distance: m.distance,
        pitch: m.pitch,
        panes: leaves(m.layout).map((p) => p.kind),
      })),
    }),
  });
  register({
    name: "focus_display",
    description: "Show one existing monitor in the flat focus view.",
    inputSchema: {
      type: "object",
      properties: { monitorId: { type: "string" } },
      required: ["monitorId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: (input: unknown) => {
      const x = input as { monitorId?: string };
      if (!x || !state.monitors.some((m) => m.id === x.monitorId))
        throw Error("Unknown monitor");
      focus(x.monitorId!);
      return { focused: x.monitorId };
    },
  });
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
}
