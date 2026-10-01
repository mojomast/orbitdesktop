/// <reference types="vite/client" />
import * as duckdb from '@duckdb/duckdb-wasm';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import { boundedSql, DATA_LIMITS, hashJson, sha256, type DataResult, type InputMetadata } from './data-query';

export class LocalDuckDB {
  private generation = 0;
  private worker?: Worker;
  private db?: duckdb.AsyncDuckDB;
  private connection?: duckdb.AsyncDuckDBConnection;
  engineVersion = '';
  inputs: InputMetadata[] = [];
  dispose() { this.generation++; this.worker?.terminate(); this.worker = undefined; this.db = undefined; this.connection = undefined; this.inputs = []; }
  async load(files: File[]) {
    this.dispose();
    const generation = this.generation;
    const current = () => { if (generation !== this.generation) throw Error('Cancelled'); };
    if (!files.length || files.length > DATA_LIMITS.files || files.reduce((n, f) => n + f.size, 0) > DATA_LIMITS.inputBytes) throw Error('Choose 1–16 files, at most 50 MiB total.');
    const inputs: InputMetadata[] = [];
    for (const [i, file] of files.entries()) {
      const ext = file.name.split('.').pop()?.toLowerCase();
      const kind = ext === 'csv' ? 'csv' : ext === 'parquet' ? 'parquet' : ext === 'json' || ext === 'ndjson' ? 'json' : null;
      if (!kind || inputs.some(input => input.name === file.name)) throw Error('Choose uniquely named CSV, JSON, NDJSON or Parquet files.');
      inputs.push({ name: file.name, table: `input_${i + 1}`, kind, bytes: file.size, sha256: await sha256(await file.arrayBuffer()) });
      current();
    }
    this.worker = new Worker(ehWorker);
    const db = this.db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), this.worker);
    await db.instantiate(ehWasm);
    current();
    await db.open({ query: { castBigIntToDouble: false }, maximumThreads: 1 });
    current();
    const conn = await db.connect();
    current(); this.connection = conn;
    await conn.query("SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; SET threads=1; SET memory_limit='256MB'; SET max_temp_directory_size='0B'; SET max_expression_depth=100;");
    current();
    const version = String((await conn.query('SELECT version() AS version')).toArray()[0].version);
    current(); this.engineVersion = version;
    for (const kind of ['json', 'parquet'] as const) {
      if (!inputs.some(i => i.kind === kind)) continue;
      if (this.engineVersion !== 'v1.4.3') throw Error('Local extensions require the pinned DuckDB v1.4.3 engine.');
      const url = new URL(`/vendor/duckdb/v1.4.3/wasm_eh/${kind}.duckdb_extension.wasm`, location.origin).href;
      const asset = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      current();
      if (!asset.ok) throw Error(`${kind.toUpperCase()} extension ${asset.status === 404 ? 'missing' : 'unavailable or invalid'}. Provision local assets with: node scripts/provision_data_engine.mjs --extensions-root <private-extensions-root>. CSV works without these extensions; choose CSV alone to continue.`);
      await conn.query(`LOAD '${url}'`);
      current();
    }
    // Registration/materialization must precede disabling external access. User SQL
    // never executes during this trusted phase. Paths are generated, not file names.
    for (const [i, file] of files.entries()) {
      const input = inputs[i], path = `orbit_input_${i}.${input.kind}`;
      await db.registerFileHandle(path, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
      current();
      const reader = input.kind === 'csv' ? 'read_csv_auto' : input.kind === 'json' ? 'read_json_auto' : 'read_parquet';
      await conn.query(`CREATE TABLE ${input.table} AS SELECT * FROM ${reader}('${path}') LIMIT 1000001`);
      current();
      const count = (await conn.query(`SELECT count(*) AS n FROM ${input.table}`)).toArray()[0].n;
      current();
      if (Number(count) > 1000000) throw Error('Input exceeds the 1,000,000-row import limit.');
      await db.dropFile(path);
      current();
    }
    await conn.query('SET enable_external_access=false; SET lock_configuration=true;');
    current();
    this.inputs = inputs;
    return inputs;
  }
  async query(sql: string): Promise<DataResult> {
    if (!this.connection) throw Error('Select files first.');
    const guarded = boundedSql(sql), start = performance.now();
    const table = await this.connection.query(guarded);
    const columns = table.schema.fields.map(f => ({ name: f.name, type: String(f.type) }));
    const normalize = (v: unknown): unknown => typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v, (_k, value) => typeof value === 'bigint' ? value.toString() : value)) : v;
    let bytes = new TextEncoder().encode(JSON.stringify(columns)).length, truncated = table.numRows > DATA_LIMITS.rows;
    const rows: unknown[][] = [];
    for (let rowIndex = 0; rowIndex < Math.min(table.numRows, DATA_LIMITS.rows); rowIndex++) {
      const values = columns.map((c, index) => {
        const value = table.getChildAt(index)!.get(rowIndex), type = table.schema.fields[index].type;
        if (c.type.startsWith('Decimal') && value != null) {
          const coefficient = String(value), scale = (type as unknown as { scale: number }).scale;
          const negative = coefficient.startsWith('-'), digits = coefficient.replace(/^-/, '').padStart(Math.max(1, scale + 1), '0');
          return (negative ? '-' : '') + (scale > 0 ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits + '0'.repeat(Math.max(0, -scale)));
        }
        return normalize(value);
      });
      const size = new TextEncoder().encode(JSON.stringify(values)).length;
      if (bytes + size > DATA_LIMITS.resultBytes) { truncated = true; break; }
      bytes += size; rows.push(values);
    }
    return { columns, rows, truncated, bytes, sha256: await hashJson({ columns, rows }), elapsedMs: performance.now() - start };
  }
}
