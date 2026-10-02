import Ajv from 'ajv';
export const DATA_RECIPE_LIMITS = { fileBytes: 256 * 1024, recipes: 500 };
const string = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
export const dataRecipeSchema = object({
  id: uuid, name: string(60), engine: object({ name: { const: 'duckdb-wasm' }, npmVersion: { const: '1.32.0' }, engineVersion: string(100) }),
  inputs: { type: 'array', minItems: 1, maxItems: 16, items: object({ name: string(255), table: { type: 'string', pattern: '^input_[1-9][0-9]?$' }, kind: { enum: ['csv', 'json', 'parquet'] }, bytes: { type: 'integer', minimum: 0, maximum: 50 * 1024 * 1024 }, sha256: hash }) },
  sql: string(16000), params: { type: 'array', maxItems: 0 }, inputHash: hash,
  result: object({ sha256: hash, rowCount: { type: 'integer', minimum: 0, maximum: 5000 }, bytes: { type: 'integer', minimum: 0, maximum: 2 * 1024 * 1024 }, truncated: { type: 'boolean' } }),
}, ['id', 'name', 'engine', 'inputs', 'sql', 'params', 'inputHash']);
export const dataRecipesRequestSchema = { oneOf: [
  object({ action: { const: 'list' }, workspace_id: uuid }),
  object({ action: { const: 'get' }, workspace_id: uuid, recipe_id: uuid }),
  object({ action: { const: 'save' }, workspace_id: uuid, base_revision: integer, op_id: uuid, recipe: dataRecipeSchema }),
  object({ action: { const: 'delete' }, workspace_id: uuid, base_revision: integer, op_id: uuid, recipe_id: uuid }),
] };
const ajv = new Ajv({ strict: true });
export const validateDataRecipe = ajv.compile(dataRecipeSchema);
export const validateDataRecipesRequest = ajv.compile(dataRecipesRequestSchema);
// Fixed field order, including exact table binding and file sizes.
export function recipeFingerprintValue(recipe) {
  return { engine: { name: recipe.engine.name, npmVersion: recipe.engine.npmVersion, engineVersion: recipe.engine.engineVersion }, sql: recipe.sql, params: recipe.params, inputs: recipe.inputs.map(i => ({ name: i.name, table: i.table, kind: i.kind, bytes: i.bytes, sha256: i.sha256 })) };
}
