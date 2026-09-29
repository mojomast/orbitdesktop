// Per-pane UI preferences (Normal/Workbench mode + explicit durable selections).
//
// Scope boundary: local browser storage only. This module never stores
// conversation text, excerpts, project/file bytes, credentials or model output.
// It stores the pane mode and opaque durable IDs the owner explicitly chose.
// Restoring an ID is NOT evidence that the object is still current: the pane
// Workbench loader must revalidate every restored ID against authenticated
// read-only state and fail closed (clear it and explain) rather than silently
// substituting the newest object.

export type PaneMode = 'normal' | 'workbench';

export interface PaneWorkbenchPrefs {
  mode: PaneMode;
  projectId: string | null;
  taskId: string | null;
  candidateId: string | null;
  attemptId: string | null;
  grantId: string | null;
  resultId: string | null;
  reviewId: string | null;
  /** Opaque id of the paired Normal/Workbench pane in this workspace, or null. */
  pairedPaneId: string | null;
}

const KEY_PREFIX = 'orbit-pane-prefs:';
const STORAGE_VERSION = 1;
const MAX_SERIALIZED = 4096;
// Opaque server identifiers and Hermes session/profile ids. Deliberately
// permissive about shaping but bounded and control-character free.
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function panePrefsKey(workspaceId: string, paneId: string): string {
  return `${KEY_PREFIX}${workspaceId}:${paneId}`;
}

export function defaultPanePrefs(): PaneWorkbenchPrefs {
  return {
    mode: 'normal',
    projectId: null,
    taskId: null,
    candidateId: null,
    attemptId: null,
    grantId: null,
    resultId: null,
    reviewId: null,
    pairedPaneId: null,
  };
}

export function normalizeDurableId(value: unknown): string | null {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

export function normalizePaneMode(value: unknown): PaneMode {
  return value === 'workbench' ? 'workbench' : 'normal';
}

function fallbackStorage(): PrefStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Private browsing / storage disabled.
  }
}

export function readPanePrefs(
  workspaceId: string,
  paneId: string,
  storage: PrefStorage | null = fallbackStorage(),
): PaneWorkbenchPrefs {
  const base = defaultPanePrefs();
  if (!storage) return base;
  let raw: string | null;
  try {
    raw = storage.getItem(panePrefsKey(workspaceId, paneId));
  } catch {
    return base;
  }
  if (!raw || raw.length > MAX_SERIALIZED) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
  const value = parsed as Record<string, unknown>;
  if (value.version !== STORAGE_VERSION) return base;
  return {
    mode: normalizePaneMode(value.mode),
    projectId: normalizeDurableId(value.projectId),
    taskId: normalizeDurableId(value.taskId),
    candidateId: normalizeDurableId(value.candidateId),
    attemptId: normalizeDurableId(value.attemptId),
    grantId: normalizeDurableId(value.grantId),
    resultId: normalizeDurableId(value.resultId),
    reviewId: normalizeDurableId(value.reviewId),
    pairedPaneId: normalizeDurableId(value.pairedPaneId),
  };
}

export function writePanePrefs(
  workspaceId: string,
  paneId: string,
  patch: Partial<PaneWorkbenchPrefs>,
  storage: PrefStorage | null = fallbackStorage(),
): PaneWorkbenchPrefs {
  const store = storage ?? fallbackStorage();
  const current = readPanePrefs(workspaceId, paneId, store);
  const pick = (key: keyof PaneWorkbenchPrefs) =>
    patch[key] === undefined ? current[key] : normalizeDurableId(patch[key]);
  const next: PaneWorkbenchPrefs = {
    // mode is normalized below, not through normalizeDurableId.
    mode: patch.mode === undefined ? current.mode : normalizePaneMode(patch.mode),
    projectId: pick('projectId') as string | null,
    taskId: pick('taskId') as string | null,
    candidateId: pick('candidateId') as string | null,
    attemptId: pick('attemptId') as string | null,
    grantId: pick('grantId') as string | null,
    resultId: pick('resultId') as string | null,
    reviewId: pick('reviewId') as string | null,
    pairedPaneId: pick('pairedPaneId') as string | null,
  };
  if (store) {
    const payload = JSON.stringify({ version: STORAGE_VERSION, ...next });
    if (payload.length <= MAX_SERIALIZED) {
      try {
        store.setItem(panePrefsKey(workspaceId, paneId), payload);
      } catch {
        /* Storage full or disabled; in-memory state remains authoritative. */
      }
    }
  }
  return next;
}

/** Clear the Workbench selection while preserving the pane mode. */
export function clearWorkbenchSelection(
  workspaceId: string,
  paneId: string,
  storage: PrefStorage | null = fallbackStorage(),
): PaneWorkbenchPrefs {
  return writePanePrefs(
    workspaceId,
    paneId,
    { projectId: null, taskId: null, candidateId: null, attemptId: null, grantId: null, resultId: null, reviewId: null },
    storage,
  );
}
