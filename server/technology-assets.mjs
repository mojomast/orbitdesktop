import {lstat,open,readFile} from 'node:fs/promises';
import {readFileSync,constants} from 'node:fs';
import path from 'node:path';
import {isPublishedCanvasFont} from './documents-canvas-assets.mjs';

const DUCKDB_VERSION='1.32.0';
const DUCKDB_FILES=['duckdb-browser-eh.worker.js','duckdb-eh.wasm'];
async function noSymlinks(file){
  let current=path.parse(file).root;
  for(const part of file.slice(current.length).split(path.sep)){current=path.join(current,part);if((await lstat(current)).isSymbolicLink())throw Error('Invalid asset');}
}
/** Fixed reviewed single-thread engine assets only. Models have their own verified map. */
export function createTechnologyAssets({root,runtimeRoot,securityHeaders={}}){
  const files=new Map(DUCKDB_FILES.flatMap(name=>[
    [`/vendor/duckdb/${name}`,{file:path.join(root,'node_modules/@duckdb/duckdb-wasm/dist',name),immutable:false}],
    [`/vendor/duckdb/${DUCKDB_VERSION}/${name}`,{file:path.join(root,'node_modules/@duckdb/duckdb-wasm/dist',name),immutable:true}],
  ]));
  try{
    const fonts=JSON.parse(readFileSync(path.join(root,'dist/vendor/excalidraw-0.18.1/fonts-manifest.json'),'utf8'));
    if(!Array.isArray(fonts)||fonts.length>500||fonts.some(name=>typeof name!=='string'||!isPublishedCanvasFont(name)))throw Error();
    for(const name of fonts)files.set(`/vendor/excalidraw-0.18.1/fonts/${name}`,{file:path.join(root,'dist/vendor/excalidraw-0.18.1/fonts',name),immutable:true,font:true});
  }catch{/* No canvas assets in a partial build: exact requests return 404. */}
  let voice,dataEngine;
  return {async handle(req,res,pathname){
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{...securityHeaders,Allow:'GET, HEAD'});res.end();return;}
    if(pathname.startsWith('/vendor/voice/')){
      voice??=import('./voice-model-assets.mjs').then(module=>module.createVoiceModelAssets({root,modelsRoot:process.env.ORBIT_VOICE_MODELS_ROOT??path.join(runtimeRoot,'models')}));
      return (await voice).handle(req,res,pathname);
    }
    if(pathname==='/vendor/duckdb/v1.4.3/status'||pathname.startsWith('/vendor/duckdb/v1.4.3/wasm_eh/')){
      dataEngine??=import('./data-engine-assets.mjs').then(module=>module.createDataEngineAssets({extensionsRoot:process.env.ORBIT_DUCKDB_EXTENSIONS_ROOT??path.join(runtimeRoot,'engines/duckdb')}));
      return (await dataEngine).handle(req,res,pathname);
    }
    const entry=files.get(pathname);
    if(!entry){res.writeHead(404,securityHeaders);res.end();return;}
    let fd;
    try{
      if(!entry.font){const pkg=JSON.parse(await readFile(path.join(root,'node_modules/@duckdb/duckdb-wasm/package.json'),'utf8'));if(pkg.version!==DUCKDB_VERSION)throw Error('Asset version mismatch');}
      await noSymlinks(entry.file);
      fd=await open(entry.file,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await fd.stat();
      if(!info.isFile()||info.nlink!==1||info.size>40*1024*1024)throw Error('Invalid asset');
      res.writeHead(200,{...securityHeaders,'Content-Type':entry.font?'font/woff2':pathname.endsWith('.wasm')?'application/wasm':'text/javascript; charset=utf-8','Content-Length':info.size,'Cache-Control':entry.immutable?'public, max-age=31536000, immutable':'no-store'});
      if(req.method==='HEAD')res.end();else res.end(await fd.readFile());
    }catch(error){if(!res.headersSent){res.writeHead(error.code==='ENOENT'?404:503,securityHeaders);res.end();}else res.destroy();}
    finally{await fd?.close();}
  }};
}
