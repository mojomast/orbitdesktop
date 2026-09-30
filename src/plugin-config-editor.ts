import { el, button } from './dom.ts';
import { validateConfig } from './plugins.ts';
import {
  CONFIG_KEY_PATTERN,
  pluginConfigSchemaFields,
  validateConfigAgainstSchema,
  type ConfigPrimitive,
  type ConfigFieldType,
  type PluginConfigSchema,
  type PluginConfigSchemaField,
} from './plugin-config-schema.ts';

export { CONFIG_KEY_PATTERN } from './plugin-config-schema.ts';
export type { ConfigPrimitive, ConfigFieldType } from './plugin-config-schema.ts';

/**
 * Typed, accessible editor for the API-v1 plugin config primitive map.
 *
 * The pure helpers below are deliberately DOM-free so they can be regression
 * tested with node:test. The dialog uses them for inline validation and turns a
 * validated draft into an existing `plugin_patch_config` / `plugin_configure`
 * operation. It never invents a new contract.
 *
 * An optional author-declared `schema` upgrades known fields to labelled
 * controls with help text, finite dropdowns, defaults and required markers. It
 * still writes the same primitive config map, schema-less manifests and configs
 * keep working, and declared defaults are only a fallback: they are shown but
 * never silently replace an owner-saved value.
 */

export const MAX_CONFIG_KEYS = 32;
export const MAX_CONFIG_SERIALIZED = 4096;

export interface ConfigDraftRow {
  id: number;
  key: string;
  type: ConfigFieldType;
  /** Raw text for string/number fields; unused for booleans. */
  text: string;
  /** Current checkbox state for boolean fields. */
  bool: boolean;
  /** Declared field metadata when this row comes from an author config schema. */
  schema?: PluginConfigSchemaField;
  /** Whether the key exists in the owner's saved config. Declared defaults never override it. */
  present?: boolean;
}

export interface ConfigDraftResult {
  config: Record<string, ConfigPrimitive> | null;
  /** Per-row messages keyed by row id. */
  errors: Record<number, string>;
  formError: string;
}

export interface ConfigChangePlan {
  action: 'plugin_patch_config' | 'plugin_configure';
  operation: Record<string, unknown>;
  changed: string[];
  removed: string[];
}

export function inferConfigType(value: ConfigPrimitive): ConfigFieldType {
  return typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string';
}

const hasOwn = (target: object, key: string) => Object.prototype.hasOwnProperty.call(target, key);

/**
 * Build editable rows from the saved config. Declared schema fields come first
 * in author order (with metadata attached); any additional saved keys stay as
 * generic primitive rows so schema-less and incremental configs are preserved.
 */
export function rowsFromConfig(config: Record<string, ConfigPrimitive>, schema?: PluginConfigSchema | null): ConfigDraftRow[] {
  const rows: Omit<ConfigDraftRow, 'id'>[] = [];
  const covered = new Set<string>();
  for (const field of pluginConfigSchemaFields(schema)) {
    covered.add(field.key);
    const present = hasOwn(config, field.key);
    const value = present ? config[field.key] : undefined;
    rows.push({
      key: field.key,
      type: field.type,
      text: typeof value === 'boolean' || value === undefined ? '' : String(value),
      bool: value === true,
      schema: field,
      present,
    });
  }
  for (const [key, value] of Object.entries(config)) {
    if (covered.has(key)) continue;
    rows.push({ key, type: inferConfigType(value), text: typeof value === 'boolean' ? '' : String(value), bool: value === true, present: true });
  }
  return rows.map((row, index) => ({ ...row, id: index + 1 }));
}

export function rowValue(row: ConfigDraftRow): ConfigPrimitive {
  if (row.type === 'boolean') return row.bool;
  if (row.type === 'number') return Number(row.text.trim());
  return row.text;
}

/** Declared field metadata attached to a row, when this is an author schema row. */
function schemaFieldFor(row: ConfigDraftRow): PluginConfigSchemaField | undefined {
  return row.schema;
}

/** Assemble and validate a draft, reusing the contract's validateConfig. */
export function draftConfig(rows: ConfigDraftRow[], schema?: PluginConfigSchema | null): ConfigDraftResult {
  const config: Record<string, ConfigPrimitive> = {};
  const errors: Record<number, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    const field = schemaFieldFor(row);
    if (!CONFIG_KEY_PATTERN.test(key)) { errors[row.id] = 'Use a letter first, then letters, numbers, _ or -.'; continue; }
    if (hasOwn(config, key)) { errors[row.id] = 'Duplicate field name.'; continue; }
    // An absent declared field left untouched is omitted so a shown default never
    // becomes a silent saved value. Any typed/checked value is still captured.
    if (field && row.present === false) {
      if (row.type === 'boolean') { if (!row.bool) continue; }
      else if (row.text.trim() === '') continue;
    }
    if (row.type === 'number') {
      const text = row.text.trim();
      if (text === '') { errors[row.id] = 'Enter a number.'; continue; }
      if (!Number.isFinite(Number(text))) { errors[row.id] = 'Enter a finite number.'; continue; }
    }
    config[key] = rowValue(row);
  }
  if (Object.keys(errors).length) return { config: null, errors, formError: '' };
  if (rows.length > MAX_CONFIG_KEYS) return { config: null, errors, formError: `At most ${MAX_CONFIG_KEYS} config fields are supported.` };
  if (JSON.stringify(config).length > MAX_CONFIG_SERIALIZED) return { config: null, errors, formError: `Configuration is limited to ${MAX_CONFIG_SERIALIZED} characters.` };
  try { validateConfig(config); } catch (error) { return { config: null, errors, formError: String((error as Error).message || error) }; }
  if (schema) {
    const declared = validateConfigAgainstSchema(config, schema);
    for (const row of rows) {
      const message = declared.errors[row.key.trim()];
      if (message && !errors[row.id]) errors[row.id] = message;
    }
    if (Object.keys(errors).length) return { config: null, errors, formError: '' };
  }
  return { config, errors, formError: '' };
}

/**
 * Decide the smallest existing operation that yields `next` from `previous`.
 * Removal cannot be expressed as a merge, so it falls back to the existing
 * whole-object `plugin_configure`; every other edit keeps omitted fields via
 * `plugin_patch_config`.
 */
export function planConfigChange(previous: Record<string, ConfigPrimitive>, next: Record<string, ConfigPrimitive>): ConfigChangePlan | null {
  const removed = Object.keys(previous).filter(key => !hasOwn(next, key));
  const patch: Record<string, ConfigPrimitive> = {};
  for (const [key, value] of Object.entries(next)) {
    if (!hasOwn(previous, key) || JSON.stringify(previous[key]) !== JSON.stringify(value)) patch[key] = value;
  }
  const changed = Object.keys(patch);
  if (!removed.length && !changed.length) return null;
  if (removed.length) return { action: 'plugin_configure', operation: { action: 'plugin_configure', config: next }, changed, removed };
  return { action: 'plugin_patch_config', operation: { action: 'plugin_patch_config', patch }, changed, removed };
}

/** Parse advanced JSON with the exact same primitive and schema validation as the form. */
export function parseConfigJson(text: string, schema?: PluginConfigSchema | null): { config: Record<string, ConfigPrimitive> | null; error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { return { config: null, error: `Invalid JSON: ${String((error as Error).message || error)}` }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { config: null, error: 'Configuration must be a JSON object of string, number or boolean values.' };
  try { validateConfig(parsed); } catch (error) { return { config: null, error: String((error as Error).message || error) }; }
  if (schema) {
    const declared = validateConfigAgainstSchema(parsed as Record<string, ConfigPrimitive>, schema);
    const first = Object.entries(declared.errors)[0];
    if (first) return { config: null, error: `Field "${first[0]}": ${first[1]}` };
  }
  return { config: parsed as Record<string, ConfigPrimitive>, error: '' };
}

export interface ConfigEditorOptions {
  pluginId: string;
  title: string;
  config: Record<string, ConfigPrimitive>;
  /** True when the widget window loads an external backend instead of the static app. */
  backendConnected: boolean;
  /** Optional author-declared finite field metadata from the manifest. */
  schema?: PluginConfigSchema | null;
  /** Receives the exact existing plugin operation to apply. Rejects on failure. */
  onApply: (operation: Record<string, unknown>) => Promise<void>;
}

interface RowRefs {
  wrap: HTMLElement;
  key: HTMLElement;
  value: HTMLElement | null;
  error: HTMLElement;
}

function defaultHintText(field: PluginConfigSchemaField): string {
  const rendered = typeof field.default === 'string' ? JSON.stringify(field.default) : String(field.default);
  return `Default: ${rendered}`;
}

/** Accessible replacement for the old native JSON prompt. */
export function showPluginConfigEditor(options: ConfigEditorOptions): HTMLDialogElement {
  const schemaFields = pluginConfigSchemaFields(options.schema);
  let rows = rowsFromConfig(options.config, options.schema);
  let nextId = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  let saving = false, closed = false;
  const refs = new Map<number, RowRefs>();

  const dialog = el('dialog', 'hermes-tools-dialog plugin-editor');
  dialog.setAttribute('aria-label', `Configure plugin ${options.pluginId}`);
  const heading = el('h2', 'plugin-editor-title', `Configure ${options.title}`);
  const headingId = `plugin-config-title-${options.pluginId}`;
  heading.id = headingId;
  dialog.setAttribute('aria-labelledby', headingId);
  dialog.removeAttribute('aria-label');

  const list = el('div', 'plugin-editor-rows');
  const status = el('p', 'plugin-editor-form-error plugin-editor-status');
  status.setAttribute('role', 'alert');
  status.setAttribute('aria-live', 'assertive');
  const add = button('Add field', 'Add configuration field', () => {
    if (rows.length >= MAX_CONFIG_KEYS) return;
    rows.push({ id: nextId++, key: '', type: 'string', text: '', bool: false, present: false });
    render();
    const added = refs.get(rows[rows.length - 1].id);
    added?.key.focus();
  });
  const save = button('Save configuration', 'Save configuration', () => submit());
  const cancel = button('Cancel', 'Cancel configuration', () => dialog.close());

  const advancedError = el('p', 'plugin-editor-form-error');
  advancedError.setAttribute('role', 'alert');
  advancedError.hidden = true;
  const textarea = el('textarea', 'plugin-editor-json');
  textarea.setAttribute('aria-label', 'Advanced configuration JSON');
  textarea.value = JSON.stringify(options.config, null, 2);
  const applyJson = button('Apply JSON', 'Apply advanced configuration JSON', () => {
    const parsed = parseConfigJson(textarea.value, options.schema);
    if (!parsed.config) { advancedError.textContent = parsed.error; advancedError.hidden = false; return; }
    advancedError.hidden = true;
    rows = rowsFromConfig(parsed.config, options.schema);
    nextId = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    render();
  });
  const syncJson = button('Refresh JSON from fields', 'Refresh advanced JSON from current fields', () => {
    textarea.value = JSON.stringify(draftConfig(rows, options.schema).config || {}, null, 2);
    advancedError.hidden = true;
  });
  const advanced = el('details', 'plugin-editor-advanced');
  advanced.append(el('summary', '', 'Advanced · edit raw JSON (optional)'), textarea, el('div', 'plugin-editor-advanced-actions', ''), advancedError);
  const advancedActions = advanced.querySelector('.plugin-editor-advanced-actions') as HTMLElement;
  advancedActions.append(applyJson, syncJson);

  function valueControl(row: ConfigDraftRow, index: number): HTMLElement {
    const field = schemaFieldFor(row);
    const aria = field?.title || `Configuration field ${index + 1} value`;
    if (row.type === 'boolean') {
      const box = el('input', 'plugin-field-input plugin-field-check');
      box.type = 'checkbox'; box.checked = row.bool; box.setAttribute('aria-label', aria);
      box.addEventListener('change', () => { row.bool = box.checked; refresh(); });
      return box;
    }
    if (field?.enum && field.enum.length) {
      const select = el('select', 'plugin-field-input plugin-field-select');
      select.setAttribute('aria-label', aria);
      const blank = el('option', '', '—');
      blank.value = '';
      select.append(blank);
      for (const choice of field.enum) {
        const option = el('option', '', String(choice));
        option.value = String(choice);
        select.append(option);
      }
      select.value = row.text;
      select.addEventListener('change', () => { row.text = select.value; refresh(); });
      return select;
    }
    const input = el('input', 'plugin-field-input');
    input.type = row.type === 'number' ? 'number' : 'text';
    if (row.type === 'number') {
      input.step = 'any';
      if (field?.min !== undefined) input.min = String(field.min);
      if (field?.max !== undefined) input.max = String(field.max);
    }
    input.value = row.text;
    if (field?.default !== undefined && row.present === false) input.placeholder = `Default: ${typeof field.default === 'string' ? field.default : String(field.default)}`;
    input.setAttribute('aria-label', aria);
    input.addEventListener('input', () => { row.text = input.value; refresh(); });
    return input;
  }

  function render() {
    list.replaceChildren(); refs.clear();
    rows.forEach((row, index) => {
      const field = schemaFieldFor(row);
      const wrap = el('div', 'plugin-editor-row');
      wrap.dataset.key = row.key.trim();
      if (field) wrap.classList.add('plugin-editor-row-schema');
      const keyLabel = el('label', 'plugin-field');
      keyLabel.append(el('span', 'plugin-field-label', field?.required ? 'Field name · required' : 'Field name'));
      let keyControl: HTMLElement;
      if (field) {
        keyControl = el('span', 'plugin-field-key plugin-field-key-fixed', row.key);
        keyControl.setAttribute('aria-label', `Configuration field ${index + 1} name`);
      } else {
        const keyInput = el('input', 'plugin-field-key');
        keyInput.type = 'text'; keyInput.value = row.key; keyInput.maxLength = 48;
        keyInput.setAttribute('aria-label', `Configuration field ${index + 1} name`);
        keyInput.addEventListener('input', () => { row.key = keyInput.value; refresh(); });
        keyControl = keyInput;
      }
      keyLabel.append(keyControl);

      const typeLabel = el('label', 'plugin-field');
      typeLabel.append(el('span', 'plugin-field-label', 'Type'));
      let typeControl: HTMLElement;
      if (field) {
        typeControl = el('span', 'plugin-field-type plugin-field-type-fixed', row.type);
      } else {
        const typeSelect = el('select', 'plugin-field-type');
        for (const type of ['string', 'number', 'boolean'] as const) { const option = el('option', '', type); option.value = type; typeSelect.append(option); }
        typeSelect.value = row.type;
        typeSelect.setAttribute('aria-label', `Configuration field ${index + 1} type`);
        typeSelect.addEventListener('change', () => { row.type = typeSelect.value as ConfigFieldType; render(); });
        typeControl = typeSelect;
      }
      typeLabel.append(typeControl);

      const valueLabel = el('label', 'plugin-field plugin-field-value');
      valueLabel.append(el('span', 'plugin-field-label', field?.title || 'Value'));
      if (field?.title) valueLabel.setAttribute('title', field.title);
      const control = valueControl(row, index);
      valueLabel.append(control);

      const remove = button('Remove', 'Remove configuration field', () => {
        rows = rows.filter(item => item.id !== row.id);
        render();
      });
      remove.classList.add('plugin-remove-field');
      if (field?.required) remove.disabled = true;

      const error = el('p', 'plugin-field-error');
      error.setAttribute('role', 'alert');
      wrap.append(keyLabel, typeLabel, valueLabel, remove, error);
      if (field?.description) wrap.append(el('p', 'plugin-field-hint', field.description));
      if (field?.default !== undefined) wrap.append(el('p', 'plugin-field-hint plugin-field-default-hint', defaultHintText(field)));
      refs.set(row.id, { wrap, key: keyControl, value: control, error });
      list.append(wrap);
    });
    refresh();
  }

  function refresh() {
    const draft = draftConfig(rows, options.schema);
    for (const row of rows) {
      const ref = refs.get(row.id); if (!ref) continue;
      ref.wrap.dataset.key = row.key.trim();
      const message = draft.errors[row.id] || '';
      ref.error.textContent = message;
      ref.error.hidden = !message;
      const invalid = String(!!message);
      ref.key.setAttribute('aria-invalid', invalid);
      ref.value?.setAttribute('aria-invalid', invalid);
    }
    status.textContent = draft.formError;
    status.hidden = !draft.formError;
    add.disabled = saving || rows.length >= MAX_CONFIG_KEYS;
    save.disabled = saving || !draft.config;
  }

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
    const draft = draftConfig(rows, options.schema);
    if (!draft.config) { refresh(); return; }
    const plan = planConfigChange(options.config, draft.config);
    if (!plan) { dialog.close(); return; }
    setSaving(true);
    status.textContent = 'Saving…';
    status.hidden = false;
    try {
      await options.onApply(plan.operation);
      if (closed) return;
      dialog.close();
    } catch (error) {
      if (closed) return;
      setSaving(false);
      status.textContent = String(error);
      status.hidden = false;
    }
  }

  dialog.addEventListener('keydown', event => {
    const target = event.target;
    if (event.key !== 'Enter' || event.shiftKey || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return;
    event.preventDefault();
    if (!save.disabled) void submit();
  });

  const actions = el('div', 'plugin-editor-actions');
  actions.append(save, cancel);
  dialog.append(
    heading,
    el('p', 'plugin-editor-note', 'Config values are public: they appear in the app URL fragment. Do not store secrets.'),
  );
  if (options.backendConnected) {
    const backend = el('p', 'plugin-editor-backend');
    backend.textContent = 'External backend connected. This configuration is saved to the workspace only — it is NOT sent to the external service, and the window loads the backend origin instead of the static app. Configure that service separately.';
    dialog.append(backend);
  }
  if (schemaFields.length) {
    const declared = `Declared by the app: ${schemaFields.length} field${schemaFields.length === 1 ? '' : 's'} with labels, help and dropdowns. Defaults are suggestions until you save them.`;
    dialog.append(el('p', 'plugin-editor-note plugin-editor-schema-note', declared));
  }
  dialog.append(
    el('p', 'plugin-editor-note', `String, number and boolean fields only · up to ${MAX_CONFIG_KEYS} fields · omitted fields are preserved.`),
    list,
    add,
    status,
    advanced,
    actions,
  );
  dialog.addEventListener('close', () => { closed = true; dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
  render();
  if (!closed) {
    const first = rows.length ? refs.get(rows[0].id) : undefined;
    (first?.value || first?.key || save).focus();
  }
  return dialog;
}
