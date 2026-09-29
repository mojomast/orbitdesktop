import fs from 'node:fs';

const [specPath, outPath] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const { SqliteWorkspaceStore } = await import(new URL('../../server/sqlite-workspace-store.mjs', import.meta.url));
const store = new SqliteWorkspaceStore(spec.root);
let applyCalls = 0;
const output = store.commit(spec.command, {
  apply: (record) => {
    applyCalls++;
    return { ...record.state, sidebarHidden: true };
  },
  response: (record) => ({
    revision: record.revision, hidden: record.state.sidebarHidden === true, marker: spec.marker,
  }),
});
fs.writeFileSync(outPath, JSON.stringify({ output, applyCalls }));
// Deliberately bypass store.close() to exercise recovery of committed WAL data.
process.exit(0);
