export const DATA_LIMITS = { files: 16, inputBytes: 50 * 1024 * 1024, rows: 5000, resultBytes: 2 * 1024 * 1024, sqlChars: 16000, timeoutMs: 30000 };
export type InputMetadata = { name: string; table: string; kind: 'csv' | 'json' | 'parquet'; bytes: number; sha256: string };
export type DataResult = { columns: { name: string; type: string }[]; rows: unknown[][]; truncated: boolean; bytes: number; sha256: string; elapsedMs: number };
export async function sha256(bytes: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function hashJson(value: unknown) { return sha256(new TextEncoder().encode(JSON.stringify(value))); }
// This scanner enforces one expression; DuckDB's parser then enforces SELECT-only
// by placing it in a derived table. Engine permissions, not keyword detection,
// enforce filesystem/network/extension confinement.
export function boundedSql(sql: string): string {
  if (!sql.trim() || sql.length > DATA_LIMITS.sqlChars) throw Error('SQL must contain one bounded SELECT (maximum 16000 characters).');
  let quote = '', comment = '', clean = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (comment === '--') { if (c === '\n') { comment = ''; clean += '\n'; } continue; }
    if (comment === '/*') { if (c === '*' && next === '/') { comment = ''; i++; } continue; }
    if (quote) { clean += c; if (c === quote) { if (next === quote) { clean += next; i++; } else quote = ''; } continue; }
    if (c === '-' && next === '-') { comment = '--'; i++; clean += ' '; continue; }
    if (c === '/' && next === '*') { comment = '/*'; i++; clean += ' '; continue; }
    if (c === "'" || c === '"') { quote = c; clean += c; continue; }
    if (c === ';') { if (sql.slice(i + 1).trim()) throw Error('Only one SELECT is allowed.'); continue; }
    clean += c;
  }
  if (quote || comment === '/*' || !/^\s*(SELECT|WITH|FROM)\b/i.test(clean)) throw Error('Only SELECT, WITH … SELECT or FROM queries are allowed.');
  return `SELECT * FROM (${clean}) AS orbit_bounded_result LIMIT ${DATA_LIMITS.rows + 1}`;
}
export function inputStatus(expected: InputMetadata[], actual: InputMetadata[]) {
  return expected.map(input => ({ name: input.name, status: !actual.some(a => a.name === input.name) ? 'missing' : actual.some(a => a.name === input.name && a.sha256 === input.sha256 && a.bytes === input.bytes && a.table === input.table && a.kind === input.kind) ? 'verified' : 'changed' }));
}
export function resultCsv(result: DataResult) {
  const cell = (v: unknown) => '"' + String(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v).replaceAll('"', '""') + '"';
  return [result.columns.map(c => cell(c.name)).join(','), ...result.rows.map(row => row.map(cell).join(','))].join('\r\n');
}
export function recipeFingerprint(recipe: { engine: {name: string; npmVersion: string; engineVersion: string}; sql: string; params: unknown[]; inputs: InputMetadata[] }) {
  return { engine: { name: recipe.engine.name, npmVersion: recipe.engine.npmVersion, engineVersion: recipe.engine.engineVersion }, sql: recipe.sql, params: recipe.params, inputs: recipe.inputs.map(i => ({ name: i.name, table: i.table, kind: i.kind, bytes: i.bytes, sha256: i.sha256 })) };
}
// Pure validator for browser import: no runtime code generation / unsafe-eval.
// Server independently checks its strict JSON schema and fingerprint on save.
export function validateRecipeImport(value: any): boolean {
  const exact = (o: any, required: string[], optional: string[] = []) => !!o && typeof o === 'object' && !Array.isArray(o) && required.every(k => Object.hasOwn(o, k)) && Object.keys(o).every(k => [...required, ...optional].includes(k));
  const text = (s: unknown, max: number) => typeof s === 'string' && s.length > 0 && s.length <= max;
  const hash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  if (!exact(value, ['id','name','engine','inputs','sql','params','inputHash'], ['result']) || !text(value.id,36) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id) || !text(value.name,60) || !text(value.sql,16000) || !hash(value.inputHash) || !Array.isArray(value.params) || value.params.length !== 0) return false;
  if (!exact(value.engine,['name','npmVersion','engineVersion']) || value.engine.name !== 'duckdb-wasm' || value.engine.npmVersion !== '1.32.0' || !text(value.engine.engineVersion,100)) return false;
  if (!Array.isArray(value.inputs) || !value.inputs.length || value.inputs.length > 16 || !value.inputs.every((i: any) => exact(i,['name','table','kind','bytes','sha256']) && text(i.name,255) && text(i.table,8) && /^input_[1-9][0-9]?$/.test(i.table) && ['csv','json','parquet'].includes(i.kind) && Number.isSafeInteger(i.bytes) && i.bytes >= 0 && hash(i.sha256)) || value.inputs.reduce((n: number,i: InputMetadata) => n+i.bytes,0) > DATA_LIMITS.inputBytes || new Set(value.inputs.map((i: InputMetadata)=>i.name)).size !== value.inputs.length || new Set(value.inputs.map((i: InputMetadata)=>i.table)).size !== value.inputs.length) return false;
  const r=value.result;
  return !Object.hasOwn(value, 'result') || (exact(r,['sha256','rowCount','bytes','truncated']) && hash(r.sha256) && Number.isSafeInteger(r.rowCount) && r.rowCount >= 0 && r.rowCount <= 5000 && Number.isSafeInteger(r.bytes) && r.bytes >= 0 && r.bytes <= DATA_LIMITS.resultBytes && typeof r.truncated === 'boolean');
}
