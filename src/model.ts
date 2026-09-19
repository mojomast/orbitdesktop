export type PaneKind = "terminal" | "browser" | "agent";
export interface Pane {
  id: string;
  kind: PaneKind;
  url: string;
}
export type Layout =
  | { type: "pane"; pane: Pane }
  | {
      type: "split";
      axis: "row" | "column";
      ratio: number;
      first: Layout;
      second: Layout;
    };
export interface Monitor {
  id: string;
  name: string;
  diagonal: number;
  aspect: string;
  height: number;
  distance: number;
  pitch: number;
  yaw: number;
  offset: number;
  fontSize: number;
  layout: Layout;
}
export interface Workspace {
  version: 1;
  monitors: Monitor[];
  selected: string;
  arc: number;
}
export const id = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
export const pane = (kind: PaneKind = "terminal"): Layout => ({
  type: "pane",
  pane: { id: id(), kind, url: "orbit://welcome" },
});
export function monitor(index: number, kind: PaneKind = "terminal"): Monitor {
  return {
    id: id(),
    name: `Display ${String(index).padStart(2, "0")}`,
    diagonal: 32,
    aspect: "16:9",
    height: 0,
    distance: 0,
    pitch: 0,
    yaw: 0,
    offset: 0,
    fontSize: 19,
    layout: pane(kind),
  };
}
export function initial(): Workspace {
  const a = monitor(1),
    b = monitor(2, "browser"),
    c = monitor(3, "agent");
  return { version: 1, monitors: [a, b, c], selected: b.id, arc: 14 };
}
export function leaves(l: Layout): Pane[] {
  return l.type === "pane"
    ? [l.pane]
    : [...leaves(l.first), ...leaves(l.second)];
}
export function replace(
  l: Layout,
  pid: string,
  fn: (p: Pane) => Layout,
): Layout {
  return l.type === "pane"
    ? l.pane.id === pid
      ? fn(l.pane)
      : l
    : {
        ...l,
        first: replace(l.first, pid, fn),
        second: replace(l.second, pid, fn),
      };
}
export function remove(l: Layout, pid: string): Layout | null {
  if (l.type === "pane") return l.pane.id === pid ? null : l;
  const a = remove(l.first, pid),
    b = remove(l.second, pid);
  return a && b ? { ...l, first: a, second: b } : a || b;
}
export function dimensions(m: Monitor) {
  const [a, b] = m.aspect.split(":").map(Number);
  const w = ((m.diagonal * a) / Math.hypot(a, b)) * 0.095;
  return { w, h: (w * b) / a };
}
const finite = (n: unknown, min: number, max: number) =>
  typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
export function validate(value: unknown): Workspace {
  const s = value as Workspace;
  const ids = new Set<string>();
  const unique = (v: unknown) => {
    if (
      typeof v !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(v) ||
      ids.has(v)
    )
      throw Error("Invalid or duplicate identifier");
    ids.add(v);
  };
  let count = 0;
  function layout(l: Layout, depth = 0) {
    if (!l || depth > 7) throw Error("Invalid pane layout");
    if (l.type === "pane") {
      count++;
      unique(l.pane?.id);
      if (
        !["terminal", "browser", "agent"].includes(l.pane.kind) ||
        typeof l.pane.url !== "string" ||
        l.pane.url.length > 2048
      )
        throw Error("Invalid pane");
    } else if (
      l.type === "split" &&
      ["row", "column"].includes(l.axis) &&
      finite(l.ratio, 0.15, 0.85)
    ) {
      layout(l.first, depth + 1);
      layout(l.second, depth + 1);
    } else throw Error("Invalid split");
  }
  if (
    !s ||
    s.version !== 1 ||
    !Array.isArray(s.monitors) ||
    s.monitors.length < 1 ||
    s.monitors.length > 8 ||
    !finite(s.arc, 0, 30)
  )
    throw Error("Expected an Orbit v1 workspace with 1–8 monitors");
  for (const m of s.monitors) {
    unique(m.id);
    if (
      typeof m.name !== "string" ||
      m.name.length > 60 ||
      !["16:9", "16:10", "21:9", "32:9", "4:3", "9:16", "1:1"].includes(
        m.aspect,
      ) ||
      !finite(m.diagonal, 20, 55) ||
      !finite(m.height, -2, 3) ||
      !finite(m.distance, -2, 4) ||
      !finite(m.pitch, -35, 35) ||
      !finite(m.yaw, -45, 45) ||
      !finite(m.offset, -3, 3) ||
      !finite(m.fontSize, 12, 32)
    )
      throw Error("Invalid monitor settings");
    count = 0;
    layout(m.layout);
    if (count > 8) throw Error("Maximum 8 panes per monitor");
  }
  if (!s.monitors.some((m) => m.id === s.selected))
    s.selected = s.monitors[0].id;
  return s;
}
export function load() {
  try {
    return validate(
      JSON.parse(localStorage.getItem("orbit.workspace.v1") || "null"),
    );
  } catch {
    return initial();
  }
}
