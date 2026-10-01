import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createTechnologyAssets} from '../server/technology-assets.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
async function request(pathname,method='HEAD'){
  let status,headers,body;
  await createTechnologyAssets({root,runtimeRoot:'/tmp/opencode/technology-assets-no-models',securityHeaders:{'X-Content-Type-Options':'nosniff'}}).handle({method},{writeHead(code,h){status=code;headers=h;},end(bytes){body=bytes;}},pathname);
  return {status,headers,body};
}
test('installed pinned DuckDB EH serves WASM MIME without cross-origin isolation',async()=>{
  const result=await request('/vendor/duckdb/1.32.0/duckdb-eh.wasm');
  assert.equal(result.status,200);assert.equal(result.headers['Content-Type'],'application/wasm');
  assert.ok(result.headers['Content-Length']>1024*1024);assert.equal(result.body,undefined);
  assert.equal(result.headers['Cross-Origin-Embedder-Policy'],undefined);
  assert.match(result.headers['Cache-Control'],/immutable/);
  assert.equal((await request('/vendor/duckdb/duckdb-eh.wasm')).headers['Cache-Control'],'no-store');
});
test('vendor route refuses directory, traversal, threaded engine and unknown methods',async()=>{
  for(const pathname of ['/vendor/duckdb/','/vendor/duckdb/../package.json','/vendor/duckdb/duckdb-coi.wasm','/vendor/ort/missing.wasm'])assert.equal((await request(pathname)).status,404);
  assert.equal((await request('/vendor/duckdb/duckdb-eh.wasm','POST')).status,405);
});
