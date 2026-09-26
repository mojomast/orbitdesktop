// Docking placement adjunct contract (version 1).
//
// This module is the single source of truth for the strict, versioned adjunct
// placement record used only when the opt-in `?renderer=docking` renderer is
// active. It is intentionally free of DOM and `dockview-core` imports so the
// browser client and the node server can share exactly the same validation,
// pruning and conversion code (`node --experimental-strip-types` imports it
// directly).
//
// Placement NEVER lives in `Workspace` / v1 layout state. It references stable
// v1 window ids only, never pane ids, runtime handles, callbacks or arbitrary
// Dockview parameters. A window that disappears from v1 is pruned from the
// adjunct; a newly added window is simply absent and therefore defaults to the
// normal docked arrangement.

export const PLACEMENT_LIMITS = Object.freeze({
  maxWindows: 100,
  maxDepth: 32,
  maxFloats: 100,
  frame: Object.freeze({ minX: 0, maxX: 10000, minY: 0, maxY: 10000, minWidth: 80, maxWidth: 10000, minHeight: 60, maxHeight: 10000 }),
  ratio: Object.freeze({ min: 0.05, max: 0.95 }),
});

const windowIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;

export type PlacementDirection = 'horizontal' | 'vertical';

export interface PlacementFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacementGroup {
  type: 'group';
  /** Ordered tab list of stable v1 window ids. */
  windows: string[];
  active?: string;
}

export interface PlacementBranch {
  type: 'branch';
  direction: PlacementDirection;
  ratio: number;
  first: PlacementNode;
  second: PlacementNode;
}

export type PlacementNode = PlacementGroup | PlacementBranch;

export interface PlacementFloat {
  windows: string[];
  frame: PlacementFrame;
  active?: string;
}

export interface DockingPlacement {
  version: 1;
  layout: PlacementNode | null;
  floats: PlacementFloat[];
  active: string | null;
}

export function emptyPlacement(): DockingPlacement {
  return { version: 1, layout: null, floats: [], active: null };
}

export function isPlacementDirection(value: unknown): value is PlacementDirection {
  return value === 'horizontal' || value === 'vertical';
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_PLACEMENT', category: 'INVALID_OPERATION' });
}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validWindowId(value: unknown): value is string {
  return typeof value === 'string' && windowIdPattern.test(value);
}

function requireWindowId(value: unknown, seen: Set<string>, where: string): string {
  if (!validWindowId(value)) invalid(`${where} is not a valid window id`);
  if (seen.has(value)) invalid(`Duplicate window id in docking placement: ${value}`);
  seen.add(value);
  return value;
}

function objectKeysOnly(value: object, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unexpected field in ${where}: ${key}`);
}

function cloneFrame(value: unknown, where: string): PlacementFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${where} frame`);
  const frame = value as Record<string, unknown>;
  objectKeysOnly(frame, ['x', 'y', 'width', 'height'], `${where} frame`);
  const { minX, maxX, minY, maxY, minWidth, maxWidth, minHeight, maxHeight } = PLACEMENT_LIMITS.frame;
  if (!finite(frame.x, minX, maxX) || !finite(frame.y, minY, maxY) || !finite(frame.width, minWidth, maxWidth) || !finite(frame.height, minHeight, maxHeight))
    invalid(`${where} frame geometry is missing or out of bounds`);
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

function validateNode(value: unknown, seen: Set<string>, depth: number, rootDirection: PlacementDirection, where: string): PlacementNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${where}`);
  const node = value as Record<string, unknown>;
  if (depth > PLACEMENT_LIMITS.maxDepth) invalid('Docking placement is nested too deeply');
  if (node.type === 'group') {
    objectKeysOnly(node, ['type', 'windows', 'active'], where);
    if (!Array.isArray(node.windows) || node.windows.length < 1) invalid('Docking placement group requires at least one window');
    if (node.windows.length > PLACEMENT_LIMITS.maxWindows) invalid('Docking placement group has too many windows');
    if (node.active !== undefined && (!validWindowId(node.active) || !node.windows.includes(node.active))) invalid('Active tab is not in its group');
    return { type: 'group', windows: node.windows.map(window => requireWindowId(window, seen, where)), ...(node.active !== undefined ? {active: node.active as string} : {}) };
  }
  if (node.type === 'branch') {
    objectKeysOnly(node, ['type', 'direction', 'ratio', 'first', 'second'], where);
    if (!isPlacementDirection(node.direction)) invalid('Invalid docking placement branch direction');
    if (!finite(node.ratio, PLACEMENT_LIMITS.ratio.min, PLACEMENT_LIMITS.ratio.max)) invalid('Invalid docking placement branch ratio');
    return {
      type: 'branch', direction: node.direction, ratio: node.ratio,
      first: validateNode(node.first, seen, depth + 1, rootDirection, `${where}.first`),
      second: validateNode(node.second, seen, depth + 1, rootDirection, `${where}.second`),
    };
  }
  return invalid(`Unsupported docking placement node type in ${where}`);
}

/** Direction of a branch at `depth` (0 = root) given the root branch direction. */
export function directionAtDepth(depth: number, rootDirection: PlacementDirection): PlacementDirection {
  const same = depth % 2 === 0;
  if (rootDirection === 'horizontal') return same ? 'horizontal' : 'vertical';
  return same ? 'vertical' : 'horizontal';
}

export function placementWindows(placement: DockingPlacement): string[] {
  const windows: string[] = [];
  const visit = (node: PlacementNode | null) => {
    if (!node) return;
    if (node.type === 'group') windows.push(...node.windows);
    else { visit(node.first); visit(node.second); }
  };
  visit(placement.layout);
  for (const float of placement.floats) windows.push(...float.windows);
  return windows;
}

/**
 * Strict validation of an untrusted placement value. Rejects extra fields,
 * unknown node types, duplicate/empty window ids, non-finite or out-of-bounds
 * geometry, excessive depth/window counts and (when `windowIds` is supplied)
 * any reference to a window that is not part of the current v1 workspace.
 */
export function validateDockingPlacement(value: unknown, options: { windowIds?: readonly string[] } = {}): DockingPlacement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Docking placement must be an object');
  const raw = value as Record<string, unknown>;
  objectKeysOnly(raw, ['version', 'layout', 'floats', 'active'], 'docking placement');
  if (raw.version !== 1) invalid('Unsupported docking placement version');
  if (!Array.isArray(raw.floats)) invalid('Docking placement requires a floats array');
  if (raw.floats.length > PLACEMENT_LIMITS.maxFloats) invalid('Docking placement has too many floating groups');
  const seen = new Set<string>();
  let layout: PlacementNode | null = null;
  if (raw.layout !== null && raw.layout !== undefined) {
    const root = raw.layout as { type?: unknown; direction?: unknown };
    const direction = isPlacementDirection(root.direction) ? root.direction : null;
    if (root.type === 'branch' && !direction) invalid('Docking placement root branch requires a direction');
    layout = validateNode(raw.layout, seen, 0, direction ?? 'horizontal', 'layout');
  }
  const floats: PlacementFloat[] = raw.floats.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid(`Invalid docking placement float ${index}`);
    const float = entry as Record<string, unknown>;
    objectKeysOnly(float, ['windows', 'frame', 'active'], `docking placement float ${index}`);
    if (!Array.isArray(float.windows) || float.windows.length < 1) invalid('Docking placement float requires at least one window');
    if (float.windows.length > PLACEMENT_LIMITS.maxWindows) invalid('Docking placement float has too many windows');
    if (float.active !== undefined && (!validWindowId(float.active) || !float.windows.includes(float.active))) invalid('Active tab is not in its floating group');
    return {
      windows: float.windows.map(window => requireWindowId(window, seen, `float ${index}`)),
      frame: cloneFrame(float.frame, `docking placement float ${index}`),
      ...(float.active !== undefined ? {active: float.active as string} : {}),
    };
  });
  if (seen.size > PLACEMENT_LIMITS.maxWindows) invalid('Docking placement references too many windows');
  let active: string | null = null;
  if (raw.active !== null && raw.active !== undefined) {
    if (!validWindowId(raw.active)) invalid('Invalid active window id');
    if (!seen.has(raw.active)) invalid('Active window is not part of the docking placement');
    active = raw.active;
  }
  if (options.windowIds) {
    const known = new Set(options.windowIds);
    for (const window of seen) if (!known.has(window)) invalid(`Docking placement references an unknown window: ${window}`);
  }
  return { version: 1, layout, floats, active };
}

/** Drop references to windows that no longer exist, collapsing empty groups/branches. */
export function prunePlacement(placement: DockingPlacement, windowIds: readonly string[]): DockingPlacement {
  const known = new Set(windowIds);
  const pruneNode = (node: PlacementNode | null): PlacementNode | null => {
    if (!node) return null;
    if (node.type === 'group') {
      const windows = node.windows.filter(window => known.has(window));
      return windows.length ? { type: 'group', windows, ...(node.active && windows.includes(node.active) ? {active:node.active} : {}) } : null;
    }
    const first = pruneNode(node.first);
    const second = pruneNode(node.second);
    if (!first && !second) return null;
    if (!first) return second;
    if (!second) return first;
    return { type: 'branch', direction: node.direction, ratio: node.ratio, first, second };
  };
  const floats = placement.floats
    .map(float => ({ windows: float.windows.filter(window => known.has(window)), frame: { ...float.frame }, ...(float.active && known.has(float.active) ? {active:float.active} : {}) }))
    .filter(float => float.windows.length > 0);
  const layout = pruneNode(placement.layout);
  const active = placement.active && known.has(placement.active) ? placement.active : null;
  return { version: 1, layout, floats, active };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function placementEqual(a: DockingPlacement | null | undefined, b: DockingPlacement | null | undefined): boolean {
  return canonical(a ?? emptyPlacement()) === canonical(b ?? emptyPlacement());
}

function cloneNode(node: PlacementNode): PlacementNode {
  return node.type === 'group'
    ? { ...node, type: 'group', windows: [...node.windows] }
    : { type: 'branch', direction: node.direction, ratio: node.ratio, first: cloneNode(node.first), second: cloneNode(node.second) };
}

function appendToFirstGroup(node: PlacementNode | null, windows: string[]): boolean {
  if (!node) return false;
  if (node.type === 'group') { node.windows.push(...windows); return true; }
  return appendToFirstGroup(node.first, windows) || appendToFirstGroup(node.second, windows);
}

/**
 * Fill windows that are present in v1 but absent from the placement into the
 * first docked group, so a persisted/saved arrangement can never hide a newly
 * added or restored window. Newly added windows therefore default to docked.
 */
export function ensurePlacementWindows(placement: DockingPlacement, windowIds: readonly string[]): DockingPlacement {
  const present = new Set(placementWindows(placement));
  // An entirely empty placement means "no saved arrangement": leave the renderer
  // on its normal default so the first load is not rewritten into one group.
  if (present.size === 0) return placement;
  const missing = windowIds.filter(window => !present.has(window));
  if (!missing.length) return placement;
  const layout = placement.layout ? cloneNode(placement.layout) : null;
  const result: DockingPlacement = {
    version: 1, layout,
    floats: placement.floats.map(float => ({ ...float, windows: [...float.windows], frame: { ...float.frame } })),
    active: placement.active,
  };
  if (!appendToFirstGroup(result.layout, missing)) result.layout = { type: 'group', windows: [...missing] };
  return result;
}

// --- Dockview conversion ---------------------------------------------------
// Structural types only; no runtime dependency on dockview-core.

export interface DockviewGroupState {
  id?: string;
  views?: string[];
  activeView?: string;
}

export interface DockviewGridNode {
  type: 'leaf' | 'branch';
  data: DockviewGroupState | DockviewGridNode[];
  size?: number;
  visible?: boolean;
}

export interface DockviewFloatState {
  data?: DockviewGroupState;
  grid?: { root: DockviewGridNode; width?: number; height?: number; orientation?: string };
  position?: { left?: number; top?: number; width?: number; height?: number };
}

export interface DockviewSerialized {
  grid?: { root?: DockviewGridNode; orientation?: string; width?: number; height?: number };
  panels?: Record<string, { id?: string } | undefined>;
  floatingGroups?: DockviewFloatState[];
  activeGroup?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function leafWindows(state: DockviewGroupState | undefined): string[] {
  return Array.isArray(state?.views) ? state!.views.filter(validWindowId) : [];
}

function firstLeafWindows(node: DockviewGridNode | undefined): string[] {
  if (!node || node.type === 'leaf') return leafWindows(node?.data as DockviewGroupState | undefined);
  const children = Array.isArray(node.data) ? node.data : [];
  for (const child of children) { const windows = firstLeafWindows(child); if (windows.length) return windows; }
  return [];
}

/**
 * Convert a Dockview `toJSON()` result into the strict adjunct contract.
 * Unknown panels, non-finite sizes and hidden groups are ignored; nested grids
 * inside a floating window are flattened into one float group (documented limit).
 */
export function dockviewToPlacement(serialized: DockviewSerialized | null | undefined, activeWindowId: string | null = null): DockingPlacement {
  const seen = new Set<string>();
  const rootDirection: PlacementDirection = serialized?.grid?.orientation === 'VERTICAL' ? 'vertical' : 'horizontal';
  const groups = new Map<string, string[]>();
  const convert = (node: DockviewGridNode | undefined, depth: number): PlacementNode | null => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'branch' && Array.isArray(node.data)) {
      const kept = node.data
        .map(child => ({ child, placement: convert(child, depth + 1) }))
        .filter((entry): entry is { child: DockviewGridNode; placement: PlacementNode } => entry.placement !== null);
      if (kept.length === 0) return null;
      const sizeOf = (child: DockviewGridNode) => (typeof child.size === 'number' && Number.isFinite(child.size) && child.size > 0 ? child.size : 1);
      const fold = (entries: typeof kept): PlacementNode => {
        if (entries.length === 1) return entries[0].placement;
        const middle = Math.floor(entries.length / 2), left = entries.slice(0, middle), right = entries.slice(middle);
        const total = entries.reduce((sum, entry) => sum + sizeOf(entry.child), 0) || 1;
        let ratio = left.reduce((sum, entry) => sum + sizeOf(entry.child), 0) / total;
        if (!Number.isFinite(ratio)) ratio = 0.5;
        ratio = Math.round(clamp(ratio, PLACEMENT_LIMITS.ratio.min, PLACEMENT_LIMITS.ratio.max) * 1e9) / 1e9;
        // N-ary siblings all share the SAME axis. Binary folding must not
        // invent alternating axes and turn three columns into an L-shaped grid.
        return { type: 'branch', direction: directionAtDepth(depth, rootDirection), ratio, first: fold(left), second: fold(right) };
      };
      return fold(kept);
    }
    const group = node.data as DockviewGroupState | undefined;
    const windows = leafWindows(group).filter(window => !seen.has(window));
    if (group?.id) groups.set(group.id, windows);
    if (!windows.length) return null;
    for (const window of windows) seen.add(window);
    return { type: 'group', windows, ...(group?.activeView && windows.includes(group.activeView) && group.activeView !== windows[0] ? {active:group.activeView} : {}) };
  };
  const layout = convert(serialized?.grid?.root, 0);
  const floats: PlacementFloat[] = [];
  for (const entry of serialized?.floatingGroups ?? []) {
    const windows = firstLeafWindows(entry.grid?.root ?? (entry.data ? { type: 'leaf', data: entry.data } : undefined)).filter(window => !seen.has(window));
    if (!windows.length) continue;
    const position = entry.position ?? {};
    const x = Number.isFinite(position.left) ? position.left! : 32;
    const y = Number.isFinite(position.top) ? position.top! : 32;
    const width = Number.isFinite(position.width) ? position.width! : 600;
    const height = Number.isFinite(position.height) ? position.height! : 420;
    for (const window of windows) seen.add(window);
    floats.push({ windows, ...(entry.data?.activeView && windows.includes(entry.data.activeView) && entry.data.activeView !== windows[0] ? {active:entry.data.activeView} : {}), frame: {
      x: clamp(x, 0, PLACEMENT_LIMITS.frame.maxX), y: clamp(y, 0, PLACEMENT_LIMITS.frame.maxY),
      width: clamp(width, PLACEMENT_LIMITS.frame.minWidth, PLACEMENT_LIMITS.frame.maxWidth),
      height: clamp(height, PLACEMENT_LIMITS.frame.minHeight, PLACEMENT_LIMITS.frame.maxHeight),
    } });
  }
  let active: string | null = null;
  if (activeWindowId && seen.has(activeWindowId)) active = activeWindowId;
  else if (serialized?.activeGroup) {
    const windows = groups.get(serialized.activeGroup) ?? [];
    const first = windows.find(window => seen.has(window)) ?? null;
    if (first) active = first;
  }
  return { version: 1, layout, floats, active };
}

/**
 * Build a Dockview `fromJSON` payload from the adjunct contract. Group ids are
 * deterministic and all panels use the `orbit-window` component the renderer
 * registers; live monitor DOM is moved over the resulting placeholders rather
 * than recreated, so no PaneView/terminal is disposed by a placement change.
 */
export function placementToDockview(placement: DockingPlacement, panels: readonly { id: string; title?: string }[]): DockviewSerialized {
  const panelState: Record<string, { id: string; contentComponent: string; renderer: 'always'; title?: string }> = {};
  const title = new Map(panels.map(panel => [panel.id, panel.title]));
  for (const window of placementWindows(placement)) {
    panelState[window] = { id: window, contentComponent: 'orbit-window', renderer: 'always', ...(title.get(window) !== undefined ? { title: title.get(window) } : {}) };
  }
  let groupIndex = 0;
  let activeGroup: string | undefined;
  const build = (node: PlacementNode | null): DockviewGridNode | null => {
    if (!node) return null;
    if (node.type === 'group') {
      const id = `orbit-group-${groupIndex++}`;
      const activeView = node.windows.find(window => window === placement.active) ?? node.active ?? node.windows[0];
      if (placement.active && node.windows.includes(placement.active)) activeGroup = id;
      return { type: 'leaf', data: { id, views: [...node.windows], activeView } };
    }
    const children: DockviewGridNode[] = [];
    const append = (part: PlacementNode, weight: number) => {
      if (part.type === 'branch' && part.direction === node.direction) {
        append(part.first, weight * part.ratio); append(part.second, weight * (1 - part.ratio));
      } else {
        const child = build(part);
        if (child) { child.size = weight * 10000; children.push(child); }
      }
    };
    append(node, 1);
    return { type: 'branch', data: children, size: 1 };
  };
  const root = build(placement.layout);
  // Dockview's `fromJSON` requires the grid root to be a branch. A single docked
  // group (the common case) is wrapped in a one-child branch; the converter
  // unwraps it again on save, so the adjunct remains a plain group.
  const gridRoot: DockviewGridNode = root
    ? (root.type === 'leaf' ? { type: 'branch', data: [root], size: 1 } : root)
    : { type: 'branch', data: [{ type: 'leaf', data: { id: 'orbit-group-0', views: [] } }], size: 1 };
  let floatIndex = 0;
  const floatingGroups: DockviewFloatState[] = [];
  for (const float of placement.floats) {
    const id = `orbit-float-${floatIndex++}`;
    const activeView = float.windows.find(window => window === placement.active) ?? float.active ?? float.windows[0];
    floatingGroups.push({ data: { id, views: [...float.windows], activeView }, position: { left: float.frame.x, top: float.frame.y, width: float.frame.width, height: float.frame.height } });
  }
  if (!activeGroup && placement.active) {
    for (const float of floatingGroups) if (float.data?.views?.includes(placement.active)) activeGroup = float.data.id;
  }
  const firstWindows = placementWindows(placement).filter(window => !placement.floats.some(float => float.windows.includes(window)));
  let resolvedActiveGroup = activeGroup;
  if (!resolvedActiveGroup && placement.active && firstWindows.includes(placement.active)) resolvedActiveGroup = `orbit-group-0`;
  return {
    grid: { root: gridRoot, width: 1000, height: 1000, orientation: placement.layout && placement.layout.type === 'branch' ? rootDirectionToOrientation(placement.layout.direction) : 'HORIZONTAL' },
    panels: panelState,
    ...(floatingGroups.length ? { floatingGroups } : {}),
    ...(resolvedActiveGroup ? { activeGroup: resolvedActiveGroup } : {}),
  };
}

function rootDirectionToOrientation(direction: PlacementDirection): 'HORIZONTAL' | 'VERTICAL' {
  return direction === 'vertical' ? 'VERTICAL' : 'HORIZONTAL';
}
