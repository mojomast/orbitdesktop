import './data-workbench.css';
import { LocalDuckDB } from './duckdb-client';
import { DATA_LIMITS, boundedSql, hashJson, inputStatus, resultCsv, validateRecipeImport, recipeFingerprint, type DataResult, type InputMetadata } from './data-query';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';
import { requestConversationContext } from './conversation-transfer';

type Recipe = { id: string; name: string; engine: { name: 'duckdb-wasm'; npmVersion: '1.32.0'; engineVersion: string }; inputs: InputMetadata[]; sql: string; params: []; inputHash: string; result?: { sha256: string; rowCount: number; bytes: number; truncated: boolean } };
export function mountDataWorkbench(host: HTMLElement, token: () => string, _options?: { paneId?: string }): { dispose(): void } {
  const root = document.createElement('section'); root.className = 'data-workbench';
  root.innerHTML = `<h2>Local Data Lab</h2><p>DuckDB-Wasm EH · local files only · 50 MiB maximum. File bytes stay in this browser. Recipes are private server metadata.</p><label>Choose CSV, JSON, NDJSON or Parquet<input class="data-files" type="file" multiple accept=".csv,.json,.ndjson,.parquet"></label><pre class="data-inputs"></pre><label>SQL (read-only SELECT)<textarea class="data-sql" rows="6" spellcheck="false">SELECT * FROM input_1</textarea></label><div class="data-actions"></div><p class="data-status" role="status" aria-live="polite">Choose files to initialize the local engine.</p><div class="data-results"></div><label>Recipe name<input class="data-name" maxlength="60" value="Local analysis"></label><div class="data-recipe-actions"></div><label>Saved private recipes<select class="data-recipes"><option value="">Choose a recipe</option></select></label><details><summary>Exact recipe / input verification</summary><pre class="data-recipe-preview"></pre></details>`;
  host.append(root);
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const files = q<HTMLInputElement>('.data-files'), sql = q<HTMLTextAreaElement>('.data-sql'), name = q<HTMLInputElement>('.data-name'), status = q('.data-status'), inputsView = q('.data-inputs'), resultsView = q('.data-results'), preview = q('.data-recipe-preview'), selection = q<HTMLSelectElement>('.data-recipes');
  const engine = new LocalDuckDB();
  let disposed = false, generation = 0, busy = false, timer: ReturnType<typeof setTimeout> | undefined;
  let inputs: InputMetadata[] = [], result: DataResult | undefined, resultSql = '', expected: Recipe | undefined, revision = 0, recipes: Recipe[] = [], pending: Record<string, unknown> | undefined;
  let page = 0, sort = -1, descending = false;
  const selectedRows = new Set<number>(), selectedColumns = new Set<number>();
  let selectionGeneration = 0;
  const abort = new AbortController();
  const say = (text: string) => { if (!disposed) status.textContent = text; };
  function action(container: string, title: string, run: () => unknown) {
    const button = document.createElement('button'); button.textContent = title; button.type = 'button';
    button.onclick = () => { Promise.resolve().then(run).catch(error => say(String(error.message || error))); };
    q(container).append(button); return button;
  }
  function invalidate() { selectionGeneration++; selectedRows.clear(); selectedColumns.clear(); result = undefined; resultsView.replaceChildren(); }
  function cancel(message = 'Cancelled; worker terminated. Choose files again to initialize.') {
    generation++; busy = false; clearTimeout(timer); engine.dispose(); inputs = []; invalidate(); say(message); showInputs();
  }
  function showInputs() {
    inputsView.textContent = inputs.map(i => `${i.table} ← ${i.name} (${i.bytes} bytes)\nSHA-256 ${i.sha256}`).join('\n');
    preview.textContent = JSON.stringify({ recipe: expected, inputVerification: expected ? inputStatus(expected.inputs, inputs) : [] }, null, 2);
  }
  async function work(run: () => Promise<void>) {
    if (busy) throw Error('A local operation is running; Cancel first.');
    busy = true; const g = generation;
    timer = setTimeout(() => cancel('Time limit reached; worker terminated. Choose files again.'), DATA_LIMITS.timeoutMs);
    try { await run(); } catch (error) { if (g === generation) { engine.dispose(); inputs = []; showInputs(); throw error; } }
    finally { if (g === generation) { busy = false; clearTimeout(timer); } }
  }
  files.onchange = () => {
    cancel('Hashing files and initializing real DuckDB…'); const g = generation, chosen = Array.from(files.files || []);
    void work(async () => {
      const loaded = await engine.load(chosen); if (g !== generation || disposed) { engine.dispose(); return; }
      inputs = loaded; showInputs();
      const states = expected ? inputStatus(expected.inputs, inputs) : [];
      say(`DuckDB ${engine.engineVersion} · EH single-thread · ${states.some(s => s.status !== 'verified') ? 'Recipe inputs changed or missing. Running is blocked.' : 'Inputs ready.'}`);
    }).catch(error => say(error.message));
  };
  sql.oninput = invalidate;
  action('.data-actions', 'Run SELECT', async () => {
    if (expected && (expected.engine.engineVersion !== engine.engineVersion || inputStatus(expected.inputs, inputs).some(s => s.status !== 'verified') || inputs.length !== expected.inputs.length)) throw Error('Recipe engine or inputs do not match. Select exact files or explicitly start a new analysis.');
    const captured = sql.value, g = generation;
    // Validate before entering the engine-operation teardown boundary. A typo or
    // rejected statement must not discard owner-selected inputs.
    boundedSql(captured);
    invalidate(); say('Running bounded SELECT…');
    await work(async () => { const value = await engine.query(captured); if (g !== generation || disposed || captured !== sql.value) return; result = value; resultSql = captured; page = 0; sort = -1; render(); say(`${value.rows.length} bounded rows · ${value.truncated ? 'truncated' : 'complete'} · ${Math.round(value.elapsedMs)} ms · SHA-256 ${value.sha256}`); });
  });
  action('.data-actions', 'Cancel', () => cancel());
  action('.data-actions', 'Ask about schema', async () => {
    const capturedInputs = inputs, own = generation, credential = token();
    if (!inputs.length) throw Error('Choose input files first.');
    const schemas: { table: string; columns: DataResult['columns'] }[] = [];
    await work(async () => { for (const input of capturedInputs) schemas.push({ table: input.table, columns: (await engine.query(`SELECT * FROM ${input.table} LIMIT 0`)).columns }); });
    const inputHash = await hashJson(capturedInputs);
    const validate = () => { if (disposed || own !== generation || inputs !== capturedInputs || credential !== token() || (localStorage.getItem('orbit.workspace.id') || workspaceId) !== workspaceId) throw Error('Loaded inputs or workspace binding changed.'); };
    validate();
    const text = JSON.stringify({ kind: 'schema-only', inputHash, inputs: capturedInputs, schemas, proposalFormat: { inputHash, sql: 'SELECT …' }, note: 'Return a sole JSON object with inputHash and sql. The owner stages it, then runs explicitly. No sample rows included.' }, null, 2);
    if (text.length > 20000) throw Error('Schema exceeds the transfer limit.');
    await requestConversationContext({ text, title: 'Local input schemas', validate });
  });
  const proposalInput = document.createElement('textarea'); proposalInput.setAttribute('aria-label', 'SQL proposal JSON'); q('.data-actions').after(proposalInput);
  action('.data-actions', 'Stage SQL proposal', async () => {
    const value = JSON.parse(proposalInput.value), capturedInputs = inputs, prior = sql.value, own = generation;
    if (!value || Object.keys(value).sort().join() !== 'inputHash,sql' || typeof value.sql !== 'string') throw Error('Expected only inputHash and sql.');
    boundedSql(value.sql);
    if (!inputs.length || value.inputHash !== await hashJson(capturedInputs)) throw Error('Proposal input fingerprint does not match loaded files.');
    if (disposed || own !== generation || inputs !== capturedInputs || sql.value !== prior) throw Error('Analysis changed while validating proposal.');
    sql.value = value.sql; invalidate(); say('Proposed SQL staged. Review the editor, then Run SELECT explicitly.');
  });
  action('.data-actions', 'Start new analysis', () => { expected = undefined; pending = undefined; invalidate(); showInputs(); say('New analysis: selected files retained; recipe matching cleared explicitly.'); });
  function render() {
    resultsView.replaceChildren(); if (!result) return;
    const table = document.createElement('table'), header = table.createTHead().insertRow();
    header.append(document.createElement('th'));
    for (const [index, column] of result.columns.entries()) { const cell = document.createElement('th'), button = document.createElement('button'); button.textContent = `${column.name} (${column.type})`; button.onclick = () => { descending = sort === index ? !descending : false; sort = index; page = 0; render(); }; cell.append(button); header.append(cell); }
    const rows = [...result.rows];
    if (sort >= 0) rows.sort((a, b) => {
      const x = a[sort], y = b[sort]; let order: number;
      if (x == null || y == null) order = x == null ? y == null ? 0 : -1 : 1;
      else if (typeof x === 'number' && typeof y === 'number') order = x - y;
      else if (/^(U?Int|Decimal)/.test(result!.columns[sort].type) && /^-?\d+(\.\d+)?$/.test(String(x)) && /^-?\d+(\.\d+)?$/.test(String(y))) {
        const scale = Math.max(String(x).split('.')[1]?.length || 0, String(y).split('.')[1]?.length || 0);
        const integer = (v: unknown) => { const [whole, fraction = ''] = String(v).split('.'); return BigInt(whole + fraction.padEnd(scale, '0')); };
        const first = integer(x), second = integer(y); order = first < second ? -1 : first > second ? 1 : 0;
      } else order = String(x).localeCompare(String(y));
      return order * (descending ? -1 : 1);
    });
    Array.from(header.cells).slice(1).forEach((cell, index) => {
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedColumns.has(index); check.setAttribute('aria-label', `Share column ${result!.columns[index].name}`);
      check.onchange = () => { selectionGeneration++; if (check.checked) selectedColumns.add(index); else selectedColumns.delete(index); }; cell.prepend(check);
    });
    const body = table.createTBody();
    for (const row of rows.slice(page * 100, (page + 1) * 100)) {
      const tr = body.insertRow(), index = result.rows.indexOf(row), check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedRows.has(index); check.setAttribute('aria-label', `Share retained row ${index + 1}`);
      check.onchange = () => { selectionGeneration++; if (check.checked) selectedRows.add(index); else selectedRows.delete(index); }; tr.insertCell().append(check);
      for (const value of row) tr.insertCell().textContent = value == null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    const scroll = document.createElement('div'); scroll.className = 'data-table-scroll'; scroll.append(table); resultsView.append(scroll);
    const controls = document.createElement('div');
    for (const [label, delta] of [['Previous page', -1], ['Next page', 1]] as const) { const button = document.createElement('button'); button.textContent = label; button.disabled = delta < 0 ? page === 0 : (page + 1) * 100 >= rows.length; button.onclick = () => { page += delta; render(); }; controls.append(button); }
    controls.append(document.createTextNode(` Page ${page + 1} of ${Math.max(1, Math.ceil(rows.length / 100))} · sorting is within bounded results`)); resultsView.append(controls);
  }
  function download(filename: string, text: string, type: string) {
    if (new TextEncoder().encode(text).length > 5 * 1024 * 1024) throw Error('Export exceeds the 5 MiB download limit.');
    const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  for (const format of ['CSV', 'JSON']) action('.data-actions', `Export bounded ${format}`, () => { if (!result) throw Error('Run a query first.'); download(`bounded-result.${format.toLowerCase()}`, format === 'CSV' ? resultCsv(result) : JSON.stringify({ columns: result.columns, rows: result.rows, truncated: result.truncated }), format === 'CSV' ? 'text/csv' : 'application/json'); });
  async function recipe(): Promise<Recipe> {
    if (!result || resultSql !== sql.value || !inputs.length) throw Error('Run the current query successfully before saving/exporting.');
    const captured = result, own = generation, capturedName = name.value, id = expected?.id || crypto.randomUUID();
    const value = { engine: { name: 'duckdb-wasm' as const, npmVersion: '1.32.0' as const, engineVersion: engine.engineVersion }, sql: resultSql, params: [] as [], inputs: inputs.map(i => ({ name: i.name, table: i.table, kind: i.kind, bytes: i.bytes, sha256: i.sha256 })) };
    const inputHash = await hashJson(value);
    if (disposed || generation !== own || result !== captured || sql.value !== value.sql) throw Error('Analysis changed while preparing recipe.');
    return { id, name: capturedName || 'Local analysis', ...value, inputHash, result: { sha256: captured.sha256, rowCount: captured.rows.length, bytes: captured.bytes, truncated: captured.truncated } };
  }
  async function api(body: Record<string, unknown>) {
    await ensureWorkspaceSynced();
    const response = await fetch('/api/data-recipes', { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, workspace_id: workspaceId }), signal: abort.signal });
    const data = await response.json();
    if (!response.ok) { if (response.status === 409 && data.current) { revision = data.current.revision; pending = undefined; } throw Error(response.status === 409 ? 'Save conflict. SQL and files retained. Refresh recipes and resolve explicitly before saving again.' : data.error || data.code || 'Recipe request failed; exact pending request retained for Retry.'); }
    revision = data.revision; recipes = data.recipes;
    selection.replaceChildren(new Option('Choose a recipe', ''), ...recipes.map(r => new Option(r.name, r.id)));
    return data;
  }
  action('.data-recipe-actions', 'Refresh recipes', async () => { await api({ action: 'list' }); say('Private recipes loaded.'); });
  action('.data-recipe-actions', 'Save recipe', async () => {
    if (pending) throw Error('Previous save outcome unknown. Retry exact save before making another save.');
    const r = await recipe(); pending = { action: 'save', base_revision: revision, op_id: crypto.randomUUID(), recipe: r };
    await api(pending); pending = undefined; expected = r; showInputs(); say('Recipe saved privately; no file bytes uploaded.');
  });
  action('.data-recipe-actions', 'Retry exact save', async () => { if (!pending) throw Error('No uncertain save to retry.'); await api(pending); pending = undefined; say('Exact save outcome recovered.'); });
  action('.data-recipe-actions', 'Export recipe + bounded result', async () => { const r = await recipe(); download('data-recipe-result.json', JSON.stringify({ version: 1, recipe: r, result }, null, 2), 'application/json'); });
  const importLabel = document.createElement('label'); importLabel.textContent = 'Import recipe JSON (metadata only)';
  const importFile = document.createElement('input'); importFile.type = 'file'; importFile.accept = '.json'; importLabel.append(importFile); q('.data-recipe-actions').after(importLabel);
  importFile.onchange = () => { void (async () => {
    const file = importFile.files?.[0]; if (!file) return;
    if (file.size > 256 * 1024) throw Error('Recipe import exceeds 256 KiB.');
    const parsed = JSON.parse(await file.text()), value = parsed.recipe ?? parsed;
    if (!validateRecipeImport(value) || value.inputHash !== await hashJson(recipeFingerprint(value))) throw Error('Invalid recipe or exact-input fingerprint.');
    expected = structuredClone(value); sql.value = value.sql; name.value = value.name; invalidate(); showInputs(); say('Imported recipe metadata. Re-select exact files; no query was run.');
  })().catch(error => say(error.message)); };
  action('.data-recipe-actions', 'Share selected result rows', async () => {
    const captured = result, own = selectionGeneration, credential = token(), scope = workspaceId;
    if (!captured || !selectedRows.size || !selectedColumns.size) throw Error('Select rows and columns using the table checkboxes first.');
    const indices = [...selectedRows].sort((a,b) => a-b), columns = [...selectedColumns].sort((a,b) => a-b);
    const r = await recipe();
    const values = { columns: columns.map(i => captured.columns[i]), retainedRowIndices: indices, rows: indices.map(i => columns.map(c => captured.rows[i][c])) };
    const selectedPayloadSha256 = await hashJson(values);
    const validate = () => { if (disposed || captured !== result || own !== selectionGeneration || r.sql !== sql.value || credential !== token() || scope !== workspaceId || (localStorage.getItem('orbit.workspace.id') || workspaceId) !== scope) throw Error('Analysis or selection changed; prepare a new transfer.'); };
    validate();
    const text = JSON.stringify({ kind: 'included-bounded-result', recipe: r, selectedPayloadSha256, resultRetainedRows: captured.rows.length, resultTruncated: captured.truncated, shareOmittedRetainedRows: captured.rows.length - indices.length, shareTruncated: false, ...values }, null, 2);
    if (text.length > 20000) throw Error('Selected values and evidence exceed 20,000 characters. Select fewer rows/columns; nothing was truncated.');
    await requestConversationContext({ title: r.name, source: 'Local DuckDB selected values (exact decimal/bigint strings)', text, validate });
  });
  selection.onchange = () => { const r = recipes.find(r => r.id === selection.value); if (!r) return; expected = structuredClone(r); sql.value = r.sql; name.value = r.name; invalidate(); showInputs(); say('Recipe loaded. Re-select exact inputs; file bytes are never restored from recipes.'); };
  const dispose = () => { if (disposed) return; disposed = true; abort.abort(); cancel(); window.removeEventListener('pagehide', dispose); root.remove(); };
  window.addEventListener('pagehide', dispose);
  return { dispose };
}
