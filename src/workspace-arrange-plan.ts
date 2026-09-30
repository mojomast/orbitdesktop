import type { Workspace } from './model.ts';
import type { WorkspaceOperation } from './workspace-contract.generated.ts';
import type { SavedLayout } from './saved-workspace-layouts-plan.ts';

export type ArrangeViewport = { width: number; height: number };
export type ArrangeMode = 'grid' | 'focus' | 'compare';
export function measuredViewport(value: ArrangeViewport): ArrangeViewport {
  const width = Math.floor(value.width), height = Math.floor(value.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 280 || height < 180 || width > 16000 || height > 16000)
    throw Error('Desktop is too small for arrangement (minimum 280 × 180 pixels).');
  return { width, height };
}

export function arrangementOperations(state: Workspace, ids: string[], mode: ArrangeMode, columns: number,
  viewport: ArrangeViewport, docking = false): WorkspaceOperation[] {
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !state.monitors.some(m => m.id === id)))
    throw Error('Select existing windows to arrange.');
  if (mode === 'focus' && ids.length !== 1) throw Error('Focus requires exactly one selected window.');
  if (mode === 'compare' && ids.length !== 2) throw Error('Compare requires exactly two selected windows.');
  if (docking) {
    if (mode !== 'focus') throw Error('Grid and Compare are unavailable in Docking: saved tab/float placement cannot be changed by frame layout operations.');
    return [{ action: 'select', window_id: ids[0] }];
  }
  const { width, height } = measuredViewport(viewport);
  const count = mode === 'focus' ? 1 : mode === 'compare' ? 2 : columns;
  if (!Number.isInteger(count) || count < 1 || count > ids.length) throw Error('Columns must be between 1 and the selected window count.');
  const rows = Math.ceil(ids.length / count);
  if ((width - 8 * (count - 1)) / count < 280 || (height - 8 * (rows - 1)) / rows < 180)
    throw Error('Desktop is too small for this grid. Choose fewer columns or windows, or enlarge the desktop.');
  return [{ action: 'arrange_windows', width, height, columns: count, gap: 8, window_ids: [...ids] },
    ...(mode === 'focus' ? [{ action: 'select' as const, window_id: ids[0] }] : [])];
}

export interface ArrangementPreview {
  savedLayout?: SavedLayout;
  base_revision: number;
  before: Workspace;
  state: Workspace;
  viewport: ArrangeViewport;
  ops: WorkspaceOperation[];
  intent: string;
  operation_id: string;
}
export function requireFreshPreview(preview: ArrangementPreview, current: { revision: number; state: Workspace }, viewport: ArrangeViewport) {
  if (current.revision !== preview.base_revision || JSON.stringify(current.state) !== JSON.stringify(preview.before))
    throw Error('Workspace changed. Preview again before applying.');
  if (Math.floor(viewport.width) !== preview.viewport.width || Math.floor(viewport.height) !== preview.viewport.height)
    throw Error('Desktop size changed. Preview again before applying.');
}
