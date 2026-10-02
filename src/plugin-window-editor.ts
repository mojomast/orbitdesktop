import { el, button } from './dom.ts';

/**
 * Friendly editor for the existing `plugin_window` operation.
 *
 * Only the fields the owner actually changed are emitted, so the partial
 * `Object.assign` patch in `plugin_window` keeps every omitted setting (name,
 * font size, opacity, geometry) intact. Constraints mirror `src/model.ts` so
 * invalid drafts are caught before a workspace mutation is requested.
 */

export interface WindowFieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  optional?: boolean;
  description?: string;
}

export const WINDOW_FIELDS: readonly WindowFieldSpec[] = [
  { key: 'name', label: 'Window name', kind: 'text', description: 'Up to 60 characters.' },
  { key: 'fontSize', label: 'Font size (px)', kind: 'number', min: 6, max: 32, step: 1 },
  { key: 'spatialFontSize', label: 'Spatial font size (px)', kind: 'number', min: 6, max: 96, step: 1, optional: true, description: 'Optional. Blank keeps the current value.' },
  { key: 'opacity', label: 'Opacity', kind: 'number', min: 0.2, max: 1, step: 0.05, optional: true, description: 'Between 0.2 and 1. Blank keeps the current value.' },
  { key: 'diagonal', label: 'Diagonal (inches)', kind: 'number', min: 20, max: Number.MAX_SAFE_INTEGER, step: 1 },
  { key: 'aspect', label: 'Aspect ratio', kind: 'select', options: ['16:9', '16:10', '21:9', '32:9', '4:3', '9:16', '1:1'] },
  { key: 'height', label: 'Height offset', kind: 'number', min: -2, max: 3, step: 0.1 },
  { key: 'distance', label: 'Distance offset', kind: 'number', min: -2, max: 4, step: 0.1 },
  { key: 'pitch', label: 'Pitch (degrees)', kind: 'number', min: -35, max: 35, step: 1 },
  { key: 'yaw', label: 'Yaw (degrees)', kind: 'number', min: -45, max: 45, step: 1 },
  { key: 'offset', label: 'Horizontal offset', kind: 'number', min: -3, max: 3, step: 0.1 },
];

export interface WindowFrameFieldSpec {
  key: string;
  part: 'x' | 'y' | 'width' | 'height' | 'z';
  label: string;
  min: number;
  max: number;
}

export const WINDOW_FRAME_FIELDS: readonly WindowFrameFieldSpec[] = [
  { key: 'frame.x', part: 'x', label: 'Frame X', min: 0, max: 10000 },
  { key: 'frame.y', part: 'y', label: 'Frame Y', min: 0, max: 10000 },
  { key: 'frame.width', part: 'width', label: 'Frame width', min: 280, max: 4000 },
  { key: 'frame.height', part: 'height', label: 'Frame height', min: 180, max: 4000 },
  { key: 'frame.z', part: 'z', label: 'Frame depth (Z)', min: 0, max: 100000 },
];

/** Every setting accepted by the existing plugin_window operation. */
export const WINDOW_SETTING_KEYS = ['name', 'frame', 'fontSize', 'spatialFontSize', 'opacity', 'diagonal', 'aspect', 'height', 'distance', 'pitch', 'yaw', 'offset'] as const;

export type WindowDraftValues = Record<string, string>;

export interface WindowDraftResult {
  settings: Record<string, unknown>;
  errors: Record<string, string>;
  changedKeys: string[];
}

const inRange = (value: number, min?: number, max?: number) =>
  Number.isFinite(value) && (min === undefined || value >= min) && (max === undefined || value <= max);

export function windowDraftValues(source: object): WindowDraftValues {
  const win = source as Record<string, unknown>;
  const values: WindowDraftValues = {};
  for (const field of WINDOW_FIELDS) {
    const value = win[field.key];
    values[field.key] = value === undefined || value === null ? '' : String(value);
  }
  const frame = win.frame as Record<string, unknown> | undefined;
  for (const field of WINDOW_FRAME_FIELDS) {
    const value = frame ? frame[field.part] : undefined;
    values[field.key] = typeof value === 'number' ? String(value) : '';
  }
  return values;
}

/** Build a partial plugin_window settings object; unchanged fields are omitted. */
export function assembleWindowSettings(source: object, values: WindowDraftValues): WindowDraftResult {
  const original = source as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of WINDOW_FIELDS) {
    const raw = field.kind === 'text' ? (values[field.key] ?? '') : (values[field.key] ?? '').trim();
    if (raw === '' && field.kind !== 'text') {
      if (field.optional) continue;
      errors[field.key] = field.kind === 'select' ? 'Choose a value.' : 'Required.';
      continue;
    }
    let value: string | number;
    if (field.kind === 'number') {
      const number = Number(raw);
      if (!Number.isFinite(number)) { errors[field.key] = 'Enter a finite number.'; continue; }
      if (!inRange(number, field.min, field.max)) { errors[field.key] = `Use a value between ${field.min} and ${field.max}.`; continue; }
      value = number;
    } else if (field.kind === 'select') {
      if (!field.options || !field.options.includes(raw)) { errors[field.key] = 'Unsupported option.'; continue; }
      value = raw;
    } else {
      if (raw.length > 60) { errors[field.key] = 'Use at most 60 characters.'; continue; }
      value = raw;
    }
    if (JSON.stringify(original[field.key]) !== JSON.stringify(value)) settings[field.key] = value;
  }
  const touched = WINDOW_FRAME_FIELDS.map(field => ({ field, raw: (values[field.key] ?? '').trim() })).filter(entry => entry.raw !== '');
  if (touched.length) {
    const originalFrame = original.frame && typeof original.frame === 'object' ? original.frame as Record<string, number> : undefined;
    const frame: Record<string, number> = originalFrame ? { ...originalFrame } : {};
    for (const { field, raw } of touched) {
      const number = Number(raw);
      if (!inRange(number, field.min, field.max)) { errors[field.key] = `Use a value between ${field.min} and ${field.max}.`; continue; }
      frame[field.part] = number;
    }
    if (!errors.frame) {
      if (['x', 'y', 'width', 'height', 'z'].every(part => typeof frame[part] === 'number')) {
        if (JSON.stringify(originalFrame) !== JSON.stringify(frame)) settings.frame = frame;
      } else {
        errors.frame = 'Complete every frame field or leave them all blank.';
      }
    }
  }
  return { settings, errors, changedKeys: Object.keys(settings) };
}

export interface WindowEditorOptions {
  pluginId: string;
  title: string;
  /** Current effective monitor/window settings (live monitor or the saved instance). */
  monitor: object;
  /** Receives the partial plugin_window settings to apply. Rejects on failure. */
  onApply: (settings: Record<string, unknown>) => Promise<void>;
}

interface FieldRef {
  input: HTMLElement;
  error: HTMLElement;
}

/** Accessible replacement for the old native window-settings JSON prompt. */
export function showPluginWindowEditor(options: WindowEditorOptions): HTMLDialogElement {
  const values = windowDraftValues(options.monitor);
  let saving = false, closed = false;
  const refs = new Map<string, FieldRef>();
  const dialog = el('dialog', 'hermes-tools-dialog plugin-editor plugin-window-editor');
  const heading = el('h2', 'plugin-editor-title', `Window settings · ${options.title}`);
  heading.id = `plugin-window-title-${options.pluginId}`;
  dialog.setAttribute('aria-labelledby', heading.id);
  const status = el('p', 'plugin-editor-form-error plugin-editor-status');
  status.setAttribute('role', 'alert');
  status.setAttribute('aria-live', 'assertive');
  const summary = el('p', 'plugin-editor-note', 'Only changed settings are applied; everything else is preserved.');
  const save = button('Save window settings', 'Save window settings', () => submit());
  const cancel = button('Cancel', 'Cancel window settings', () => dialog.close());
  const form = el('div', 'plugin-editor-rows');

  function refresh() {
    const result = assembleWindowSettings(options.monitor, values);
    for (const field of WINDOW_FIELDS) {
      const ref = refs.get(field.key); if (!ref) continue;
      const message = result.errors[field.key] || '';
      ref.error.textContent = message; ref.error.hidden = !message;
      ref.input.setAttribute('aria-invalid', String(!!message));
    }
    for (const field of WINDOW_FRAME_FIELDS) {
      const ref = refs.get(field.key); if (!ref) continue;
      const message = result.errors[field.key] || '';
      ref.error.textContent = message; ref.error.hidden = !message;
      ref.input.setAttribute('aria-invalid', String(!!message));
    }
    const frameError = refs.get('frame')?.error;
    if (frameError) { frameError.textContent = result.errors.frame || ''; frameError.hidden = !result.errors.frame; }
    const count = result.changedKeys.length;
    const formError = Object.entries(result.errors).find(([, message]) => !!message);
    status.textContent = Object.keys(result.errors).length ? 'Fix the highlighted values before saving.' : '';
    status.hidden = !Object.keys(result.errors).length;
    summary.textContent = count ? `${count} setting${count === 1 ? '' : 's'} will change; everything else is preserved.` : 'Only changed settings are applied; everything else is preserved.';
    save.disabled = saving || !!formError || count === 0;
  }

  function addField(field: WindowFieldSpec) {
    const wrap = el('label', 'plugin-field');
    wrap.append(el('span', 'plugin-field-label', field.label));
    let input: HTMLInputElement | HTMLSelectElement;
    if (field.kind === 'select') {
      const select = el('select', 'plugin-field-input');
      for (const option of field.options || []) { const node = el('option', '', option); node.value = option; select.append(node); }
      select.value = values[field.key] ?? '';
      select.setAttribute('aria-label', field.label);
      select.addEventListener('change', () => { values[field.key] = select.value; refresh(); });
      input = select;
    } else {
      const node = el('input', 'plugin-field-input');
      node.type = field.kind === 'number' ? 'number' : 'text';
      if (field.kind === 'number') { node.step = String(field.step ?? 'any'); if (field.min !== undefined) node.min = String(field.min); if (field.max !== undefined) node.max = String(field.max); }
      if (field.optional) node.placeholder = 'unchanged';
      node.value = values[field.key] ?? '';
      node.setAttribute('aria-label', field.label);
      node.addEventListener('input', () => { values[field.key] = node.value; refresh(); });
      input = node;
    }
    const error = el('span', 'plugin-field-error');
    error.setAttribute('role', 'alert');
    wrap.append(input, error);
    if (field.description) wrap.append(el('span', 'plugin-field-hint', field.description));
    refs.set(field.key, { input, error });
    form.append(wrap);
  }

  for (const field of WINDOW_FIELDS) addField(field);

  const frameDetails = el('details', 'plugin-editor-advanced');
  frameDetails.append(el('summary', '', 'Advanced · window frame (position & size, optional)'));
  const frameGrid = el('div', 'plugin-editor-rows');
  for (const field of WINDOW_FRAME_FIELDS) {
    const wrap = el('label', 'plugin-field');
    wrap.append(el('span', 'plugin-field-label', field.label));
    const node = el('input', 'plugin-field-input');
    node.type = 'number'; node.step = '1'; node.min = String(field.min); node.max = String(field.max);
    node.placeholder = 'unchanged'; node.value = values[field.key] ?? '';
    node.setAttribute('aria-label', field.label);
    node.addEventListener('input', () => { values[field.key] = node.value; refresh(); });
    const error = el('span', 'plugin-field-error');
    error.setAttribute('role', 'alert');
    wrap.append(node, error);
    refs.set(field.key, { input: node, error });
    frameGrid.append(wrap);
  }
  const frameError = el('p', 'plugin-editor-form-error');
  frameError.setAttribute('role', 'alert');
  refs.set('frame', { input: frameGrid, error: frameError });
  frameDetails.append(frameGrid, frameError);

  /** Disable every editable control except Cancel while a save is in flight. */
  function setSaving(value: boolean) {
    saving = value;
    dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea').forEach(control => {
      if (control !== cancel) control.disabled = value;
    });
    if (!value) refresh();
  }

  async function submit() {
    if (saving) return;
    const result = assembleWindowSettings(options.monitor, values);
    if (Object.keys(result.errors).length) { refresh(); return; }
    if (!result.changedKeys.length) { dialog.close(); return; }
    setSaving(true);
    status.textContent = 'Saving…';
    status.hidden = false;
    try {
      await options.onApply(result.settings);
      if (closed) return;
      dialog.close();
    } catch (error) {
      if (closed) return;
      setSaving(false);
      status.textContent = String(error);
      status.hidden = false;
    }
  }

  const actions = el('div', 'plugin-editor-actions');
  actions.append(save, cancel);
  dialog.append(
    heading,
    el('p', 'plugin-editor-note', 'Friendly name, font size, opacity and geometry. Applies while the plugin is enabled or disabled; IDs and layout cannot be changed here.'),
    form,
    frameDetails,
    summary,
    status,
    actions,
  );
  dialog.addEventListener('close', () => { closed = true; dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
  if (!closed) refs.get(WINDOW_FIELDS[0].key)?.input.focus();
  refresh();
  return dialog;
}
