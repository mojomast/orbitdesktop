import type { WorkspaceOperation } from './workspace-contract.generated.ts';
import {parsePendingSavedLayout, type PendingSavedLayout} from './saved-workspace-layouts-pending.ts';

interface LegacyPendingArrangement {
  action: 'layout_apply';
  workspace_id: string;
  base_revision: number;
  operations: WorkspaceOperation[];
  operation_id: string;
  intent: string;
}
export type PendingArrangement = LegacyPendingArrangement | PendingSavedLayout;
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** Validate only the finite operations emitted by this dialog, never arbitrary stored commands. */
export function parsePendingArrangement(raw: string, workspace: string): PendingArrangement {
  if (raw.length > 64000) throw Error('Retained arrangement exceeds the storage limit.');
  const value = JSON.parse(raw);
  if(value?.action==='apply')return parsePendingSavedLayout(raw,workspace);
  if (!value || typeof value !== 'object' || !exact(value, ['action', 'workspace_id', 'base_revision', 'operations', 'operation_id', 'intent']) ||
    value.action !== 'layout_apply' || value.workspace_id !== workspace || !uuid(value.workspace_id) || !uuid(value.operation_id) ||
    !Number.isSafeInteger(value.base_revision) || value.base_revision < 0 || typeof value.intent !== 'string' || !value.intent.trim() || value.intent.length > 160 ||
    !Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 2)
    throw Error('Retained arrangement is invalid. Read saved state before discarding it.');
  for (const op of value.operations) {
    if (!op || typeof op !== 'object') throw Error('Invalid retained operation.');
    if (op.action === 'select' && exact(op, ['action', 'window_id']) && identifier(op.window_id)) continue;
    if (op.action === 'arrange_windows' && exact(op, ['action', 'width', 'height', 'columns', 'gap', 'window_ids']) &&
      number(op.width, 280, 16000) && number(op.height, 180, 16000) && number(op.gap, 0, 100) &&
      Array.isArray(op.window_ids) && op.window_ids.length > 0 && op.window_ids.every(identifier) &&
      new Set(op.window_ids).size === op.window_ids.length && Number.isInteger(op.columns) && op.columns >= 1 && op.columns <= op.window_ids.length) continue;
    throw Error('Invalid retained operation.');
  }
  return value as PendingArrangement;
}
export const pendingArrangementKey = (workspace: string) => `orbit.workspace.arrange.pending.${workspace}`;
export function storePendingArrangement(storage: Storage, command: PendingArrangement) {
  const raw = JSON.stringify(command);
  parsePendingArrangement(raw, command.workspace_id);
  const key = pendingArrangementKey(command.workspace_id);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw Error('Exact arrangement could not be retained; nothing was dispatched.');
}
