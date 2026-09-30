// Browser-local experimental feature switches, off unless the owner enables
// them in Orbit settings.
//
// Scope boundary: preferences only. This module never stores credentials,
// conversation text, project/file bytes or model output. Disabling a feature
// hides its client surfaces; it never deletes durable tasks, candidates,
// results, journals or conversations, and it never revokes server authority.

export type ExperimentalFeature = 'workbench';

export interface ExperimentalState {
  workbench: boolean;
}

export interface ExperimentalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'orbit.experimental.v1';
export const EXPERIMENTAL_CHANGED_EVENT = 'orbit-experimental-changed';
const STORAGE_VERSION = 1;
const MAX_SERIALIZED = 4096;

export function experimentalStorageKey(): string {
  return KEY;
}

function fallbackStorage(): ExperimentalStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Private browsing / storage disabled.
  }
}

export function defaultExperimental(): ExperimentalState {
  return { workbench: false };
}

export function readExperimental(storage: ExperimentalStorage | null = fallbackStorage()): ExperimentalState {
  const base = defaultExperimental();
  if (!storage) return base;
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
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
  return { workbench: value.workbench === true };
}

export function experimentalEnabled(
  feature: ExperimentalFeature,
  storage: ExperimentalStorage | null = fallbackStorage(),
): boolean {
  return readExperimental(storage)[feature];
}

/** Persist one feature switch and notify subscribed surfaces. */
export function setExperimentalFeature(
  feature: ExperimentalFeature,
  enabled: boolean,
  storage: ExperimentalStorage | null = fallbackStorage(),
): ExperimentalState {
  const next: ExperimentalState = { ...readExperimental(storage), [feature]: enabled === true };
  if (storage) {
    const payload = JSON.stringify({ version: STORAGE_VERSION, ...next });
    if (payload.length <= MAX_SERIALIZED) {
      try {
        storage.setItem(KEY, payload);
      } catch {
        /* Storage full or disabled; the caller's UI state remains authoritative. */
      }
    }
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EXPERIMENTAL_CHANGED_EVENT));
  return next;
}

export function subscribeExperimental(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EXPERIMENTAL_CHANGED_EVENT, listener);
  return () => window.removeEventListener(EXPERIMENTAL_CHANGED_EVENT, listener);
}
