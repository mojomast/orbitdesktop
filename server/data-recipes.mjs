import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_RECIPE_LIMITS, validateDataRecipe, validateDataRecipesRequest, recipeFingerprintValue } from '../contracts/data-recipes-v1.mjs';
const fail = (code, extra = {}) => Object.assign(Error(code), { code, ...extra });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lstat = file => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export function createDataRecipes({ root, workspaceRead }) {
  function directory() {
    // Refuse symlink ancestors too; private roots are trusted paths, never request data.
    const dir = path.resolve(root, 'data-recipes');
    let cursor = dir;
    while (cursor !== path.dirname(cursor)) {
      const stat = lstat(cursor);
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw fail('unavailable');
      cursor = path.dirname(cursor);
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((fs.lstatSync(dir).mode & 0o777) !== 0o700) throw fail('unavailable');
    return dir;
  }
  function validRecipe(recipe) {
    if (!validateDataRecipe(recipe) || recipe.inputHash !== digest(recipeFingerprintValue(recipe)) || new Set(recipe.inputs.map(i => i.name)).size !== recipe.inputs.length || new Set(recipe.inputs.map(i => i.table)).size !== recipe.inputs.length || recipe.inputs.reduce((n, i) => n + i.bytes, 0) > 50 * 1024 * 1024) throw fail('invalid_request');
  }
  function read(id) {
    const file = path.join(directory(), `${id}.json`);
    const stat = lstat(file);
    if (!stat) return { version: 1, workspace_id: id, revision: 0, recipes: [], receipts: [] };
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > DATA_RECIPE_LIMITS.fileBytes) throw fail('unavailable');
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Object.keys(value).sort().join() !== 'receipts,recipes,revision,version,workspace_id' || value.version !== 1 || value.workspace_id !== id || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.recipes) || value.recipes.length > 500 || !Array.isArray(value.receipts) || value.receipts.length > 64) throw Error();
      value.recipes.forEach(validRecipe);
      if (new Set(value.recipes.map(r => r.id)).size !== value.recipes.length) throw Error();
      for (const r of value.receipts) if (Object.keys(r).sort().join() !== 'digest,op_id,revision' || !/^[a-f0-9-]{36}$/.test(r.op_id) || !/^[a-f0-9]{64}$/.test(r.digest) || !Number.isSafeInteger(r.revision) || r.revision < 1 || r.revision > value.revision) throw Error();
      return value;
    } catch { throw fail('unavailable'); }
  }
  function write(value) {
    const dir = directory(), file = path.join(dir, `${value.workspace_id}.json`), text = JSON.stringify(value);
    if (Buffer.byteLength(text) > DATA_RECIPE_LIMITS.fileBytes) throw fail('limit_exceeded');
    const temporary = path.join(dir, `.write-${randomUUID()}`);
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file);
      const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  }
  const snapshot = record => ({ workspace_id: record.workspace_id, revision: record.revision, recipes: record.recipes });
  // No await between read/CAS/write: dispatches serialize in this service process.
  async function dispatch(body) {
    if (!validateDataRecipesRequest(body)) throw fail('invalid_request');
    let workspace;
    try { workspace = await workspaceRead(body.workspace_id); } catch { throw fail('unavailable'); }
    if (!workspace) throw fail('unavailable');
    const record = read(body.workspace_id);
    if (body.action === 'list') return snapshot(record);
    if (body.action === 'get') { const recipe = record.recipes.find(r => r.id === body.recipe_id); if (!recipe) throw fail('unavailable'); return { ...snapshot(record), recipe }; }
    if (body.action === 'save') validRecipe(body.recipe);
    const payloadDigest = digest(body), receipt = record.receipts.find(r => r.op_id === body.op_id);
    if (receipt) { if (receipt.digest !== payloadDigest) throw fail('operation_mismatch'); return { ...snapshot(record), replayed: true, committed_revision: receipt.revision }; }
    if (body.base_revision !== record.revision) throw fail('conflict', { current: snapshot(record) });
    const recipes = record.recipes.filter(r => r.id !== (body.recipe?.id ?? body.recipe_id));
    if (body.action === 'save') recipes.push(structuredClone(body.recipe));
    if (recipes.length > 500 || !Number.isSafeInteger(record.revision + 1)) throw fail('limit_exceeded');
    const next = { ...record, recipes, revision: record.revision + 1, receipts: [...record.receipts, { op_id: body.op_id, digest: payloadDigest, revision: record.revision + 1 }].slice(-64) };
    write(next); return { ...snapshot(next), committed_revision: next.revision, replayed: false };
  }
  return { dispatch };
}
