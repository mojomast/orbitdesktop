import { validateConfig } from './plugins.ts';

/**
 * Author-defined, finite metadata for the existing API-v1 primitive config map.
 *
 * A manifest may carry an OPTIONAL `configSchema`. It is a closed, bounded and
 * purely declarative description: no regex, no executable templates, no nested
 * objects, no arbitrary JSON Schema and no evaluation. Every field maps to one
 * of the existing `string | number | boolean` config primitives, so schema-less
 * manifests and configs remain valid exactly as before.
 *
 * The schema is public metadata: it is emitted into the manifest and may be
 * shown in the workspace. It must never carry secrets. The bundle hash policy is
 * unchanged — the content address still covers only the served bundle files, so
 * schema metadata never mutates `entry` or the digest.
 */

export type ConfigPrimitive = string | number | boolean;
export type ConfigFieldType = 'string' | 'number' | 'boolean';

export const CONFIG_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/;
export const MAX_CONFIG_SCHEMA_FIELDS = 32;
export const MAX_CONFIG_SCHEMA_SERIALIZED = 8192;
export const MAX_CONFIG_SCHEMA_ENUM = 32;
export const MAX_SCHEMA_TITLE = 60;
export const MAX_SCHEMA_DESCRIPTION = 200;
export const MAX_SCHEMA_STRING_VALUE = 4096;

const FIELD_PROPERTIES = new Set(['key', 'type', 'title', 'description', 'default', 'enum', 'min', 'max', 'required']);
const TYPES: readonly ConfigFieldType[] = ['string', 'number', 'boolean'];

export interface PluginConfigSchemaField {
  /** Bound to an existing config key; the same key pattern as `validateConfig`. */
  key: string;
  type: ConfigFieldType;
  /** Optional human label. Defaults to the key. */
  title?: string;
  /** Optional inline help text. */
  description?: string;
  /** Suggested value when the owner has not saved this key. Never overrides a saved value. */
  default?: ConfigPrimitive;
  /** Finite dropdown choices for `string` values (single-choice). */
  enum?: ConfigPrimitive[];
  /** Inclusive lower bound for `number` fields. */
  min?: number;
  /** Inclusive upper bound for `number` fields. */
  max?: number;
  /** When true the effective config must resolve this key (a `default` satisfies it). */
  required?: boolean;
}

export interface PluginConfigSchema {
  fields: PluginConfigSchemaField[];
}

export interface SchemaConfigValidation {
  errors: Record<string, string>;
  formError: string;
}

function fail(message: string): never {
  throw new Error(`Invalid plugin config schema: ${message}`);
}

function isPrimitive(value: unknown): value is ConfigPrimitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) < 32) return true;
  return false;
}

function validateStringValue(value: string, label: string): void {
  if (value.length > MAX_SCHEMA_STRING_VALUE) fail(`${label} must be at most ${MAX_SCHEMA_STRING_VALUE} characters`);
  if (hasControlChars(value)) fail(`${label} must not contain control characters`);
}

function validateField(value: unknown, index: number, seen: Set<string>): PluginConfigSchemaField {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`field ${index + 1} must be an object`);
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!FIELD_PROPERTIES.has(key)) fail(`field ${index + 1} has unsupported property "${key}"`);

  const key = raw.key;
  if (typeof key !== 'string' || !CONFIG_KEY_PATTERN.test(key)) fail(`field ${index + 1} key must match ${CONFIG_KEY_PATTERN}`);
  if (seen.has(key)) fail(`duplicate field key "${key}"`);
  seen.add(key);

  const type = raw.type;
  if (typeof type !== 'string' || !TYPES.includes(type as ConfigFieldType)) fail(`field "${key}" type must be string, number or boolean`);
  const fieldType = type as ConfigFieldType;

  const field: PluginConfigSchemaField = { key, type: fieldType };

  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || raw.title.length < 1 || raw.title.length > MAX_SCHEMA_TITLE || hasControlChars(raw.title)) fail(`field "${key}" title must be 1–${MAX_SCHEMA_TITLE} printable characters`);
    field.title = raw.title;
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > MAX_SCHEMA_DESCRIPTION || hasControlChars(raw.description)) fail(`field "${key}" description must be at most ${MAX_SCHEMA_DESCRIPTION} printable characters`);
    field.description = raw.description;
  }

  if (raw.enum !== undefined) {
    const choices = raw.enum;
    if (fieldType === 'boolean') fail(`field "${key}" boolean fields cannot declare an enum`);
    if (!Array.isArray(choices) || choices.length < 1 || choices.length > MAX_CONFIG_SCHEMA_ENUM) fail(`field "${key}" enum must have 1–${MAX_CONFIG_SCHEMA_ENUM} choices`);
    const normalized: ConfigPrimitive[] = [];
    for (const choice of choices) {
      if (!isPrimitive(choice)) fail(`field "${key}" enum choices must be string, number or boolean`);
      if (typeof choice !== fieldType) fail(`field "${key}" enum choices must match the ${fieldType} type`);
      if (typeof choice === 'number' && !Number.isFinite(choice)) fail(`field "${key}" enum numbers must be finite`);
      if (typeof choice === 'string') validateStringValue(choice, `field "${key}" enum choice`);
      if (normalized.some(existing => JSON.stringify(existing) === JSON.stringify(choice))) fail(`field "${key}" enum choices must be unique`);
      normalized.push(choice);
    }
    field.enum = normalized;
  }

  if (raw.min !== undefined || raw.max !== undefined) {
    if (fieldType !== 'number') fail(`field "${key}" min/max are only valid for number fields`);
    const min = raw.min === undefined ? undefined : raw.min;
    const max = raw.max === undefined ? undefined : raw.max;
    if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) fail(`field "${key}" min must be a finite number`);
    if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) fail(`field "${key}" max must be a finite number`);
    if (min !== undefined && max !== undefined && min > max) fail(`field "${key}" min must not exceed max`);
    if (min !== undefined) field.min = min as number;
    if (max !== undefined) field.max = max as number;
  }

  if (raw.required !== undefined) {
    if (typeof raw.required !== 'boolean') fail(`field "${key}" required must be a boolean`);
    field.required = raw.required;
  }

  if (raw.default !== undefined) {
    const subject = raw.default;
    if (!isPrimitive(subject)) fail(`field "${key}" default must be string, number or boolean`);
    if (typeof subject !== fieldType) fail(`field "${key}" default must match the ${fieldType} type`);
    if (typeof subject === 'number' && !Number.isFinite(subject)) fail(`field "${key}" default must be finite`);
    if (typeof subject === 'string') validateStringValue(subject, `field "${key}" default`);
    if (field.enum && !field.enum.some(choice => JSON.stringify(choice) === JSON.stringify(subject))) fail(`field "${key}" default must be one of the declared enum choices`);
    if (typeof subject === 'number') {
      if (field.min !== undefined && subject < field.min) fail(`field "${key}" default must be at least ${field.min}`);
      if (field.max !== undefined && subject > field.max) fail(`field "${key}" default must be at most ${field.max}`);
    }
    // A required field's effective default must itself satisfy "required", or the
    // helper would accept the metadata yet reject the same value once present.
    if (field.required === true && fieldType === 'string' && subject === '') fail(`field "${key}" required string default must not be empty`);
    field.default = subject;
  }

  return field;
}

/** Validate and normalize an author-declared config schema. Throws on any invalid shape. */
export function validatePluginConfigSchema(value: unknown): PluginConfigSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must be an object');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (key !== 'fields') fail(`unsupported property "${key}"`);
  const fields = raw.fields;
  if (!Array.isArray(fields)) fail('fields must be an array');
  if (fields.length > MAX_CONFIG_SCHEMA_FIELDS) fail(`supports at most ${MAX_CONFIG_SCHEMA_FIELDS} fields`);
  if (JSON.stringify(value).length > MAX_CONFIG_SCHEMA_SERIALIZED) fail(`serialized schema must be at most ${MAX_CONFIG_SCHEMA_SERIALIZED} characters`);
  const seen = new Set<string>();
  const normalized = fields.map((field, index) => validateField(field, index, seen));
  return { fields: normalized };
}

export function pluginConfigSchemaFields(schema?: PluginConfigSchema | null): PluginConfigSchemaField[] {
  return schema && Array.isArray(schema.fields) ? schema.fields : [];
}

/** Declared defaults keyed by field. Only fields that actually declare a default appear. */
export function configDefaults(schema?: PluginConfigSchema | null): Record<string, ConfigPrimitive> {
  const defaults: Record<string, ConfigPrimitive> = {};
  for (const field of pluginConfigSchemaFields(schema)) {
    if (field.default !== undefined) defaults[field.key] = field.default;
  }
  return defaults;
}

/**
 * Apply declared defaults for keys the owner has not saved. A saved value for a
 * key always wins, so defaults never silently override owner configuration.
 */
export function applyConfigDefaults(config: Record<string, ConfigPrimitive>, schema?: PluginConfigSchema | null): Record<string, ConfigPrimitive> {
  return { ...configDefaults(schema), ...config };
}

/**
 * Validate a config against declared fields. This supplements — never replaces —
 * the existing primitive `validateConfig` contract. Unknown keys are allowed so
 * schema-less compatibility and incremental authoring are preserved.
 */
export function validateConfigAgainstSchema(config: Record<string, ConfigPrimitive>, schema?: PluginConfigSchema | null): SchemaConfigValidation {
  const errors: Record<string, string> = {};
  for (const field of pluginConfigSchemaFields(schema)) {
    const present = Object.prototype.hasOwnProperty.call(config, field.key);
    if (!present) {
      if (field.required && field.default === undefined) errors[field.key] = 'Required.';
      continue;
    }
    const value = config[field.key];
    if (typeof value !== field.type) {
      errors[field.key] = `Enter a ${field.type} value.`;
      continue;
    }
    if (field.type === 'number' && typeof value === 'number') {
      if (!Number.isFinite(value)) { errors[field.key] = 'Enter a finite number.'; continue; }
      if (field.min !== undefined && value < field.min) { errors[field.key] = `Use a value of at least ${field.min}.`; continue; }
      if (field.max !== undefined && value > field.max) { errors[field.key] = `Use a value of at most ${field.max}.`; continue; }
    }
    if (field.enum && !field.enum.some(choice => JSON.stringify(choice) === JSON.stringify(value))) {
      errors[field.key] = `Choose one of: ${field.enum.map(choice => JSON.stringify(choice)).join(', ')}.`;
      continue;
    }
    if (field.required && field.type === 'string' && value === '') errors[field.key] = 'Required.';
  }
  return { errors, formError: '' };
}

/** Throwing helper combining the existing primitive contract with an optional schema. */
export function assertValidPluginConfig(config: unknown, schema?: PluginConfigSchema | null): Record<string, ConfigPrimitive> {
  validateConfig(config);
  const result = validateConfigAgainstSchema(config as Record<string, ConfigPrimitive>, schema);
  const first = Object.entries(result.errors)[0];
  if (first) throw new Error(`Invalid plugin config: ${first[0]} ${first[1]}`);
  return config as Record<string, ConfigPrimitive>;
}
