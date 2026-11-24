import { scratchPath } from './fixtures/scratch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createTechnologyAssets} from '../server/technology-assets.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
async function request(pathname,method='HEAD'){
  let status,headers,body;
  await createTechnologyAssets({root,runtimeRoot:scratchPath('technology-assets-no-models'),securityHeaders:{'X-Content-Type-Options':'nosniff'}}).handle({method},{writeHead(code,h){status=code;headers=h;},end(bytes){body=bytes;}},pathname);
  return {status,headers,body};
}
test('vendor route serves only reviewed canvas assets',async()=>{
  for(const pathname of ['/vendor/excalidraw-0.18.1/fonts/','/vendor/excalidraw-0.18.1/fonts/missing.woff2','/vendor/unknown/missing.wasm','/vendor/../package.json'])assert.equal((await request(pathname)).status,404);
});
test('vendor route refuses unknown methods',async()=>{
  assert.equal((await request('/vendor/excalidraw-0.18.1/fonts/missing.woff2','POST')).status,405);
});
