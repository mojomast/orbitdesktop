import {lstat,open} from 'node:fs/promises';
import {readFileSync,constants} from 'node:fs';
import path from 'node:path';
import {isPublishedCanvasFont} from './documents-canvas-assets.mjs';

async function noSymlinks(file){
  let current=path.parse(file).root;
  for(const part of file.slice(current.length).split(path.sep)){current=path.join(current,part);if((await lstat(current)).isSymbolicLink())throw Error('Invalid asset');}
}
/** Fixed reviewed canvas font assets and the pinned local dictation model. */
export function createTechnologyAssets({root,runtimeRoot,securityHeaders={}}){
  const files=new Map();
  try{
    const fonts=JSON.parse(readFileSync(path.join(root,'dist/vendor/excalidraw-0.18.1/fonts-manifest.json'),'utf8'));
    if(!Array.isArray(fonts)||fonts.length>500||fonts.some(name=>typeof name!=='string'||!isPublishedCanvasFont(name)))throw Error();
    for(const name of fonts)files.set(`/vendor/excalidraw-0.18.1/fonts/${name}`,{file:path.join(root,'dist/vendor/excalidraw-0.18.1/fonts',name),immutable:true,font:true});
  }catch{/* No canvas assets in a partial build: exact requests return 404. */}
  let voiceAssets;
  async function voice(){
    voiceAssets??=(await import('./voice-model-assets.mjs')).createVoiceModelAssets({
      modelsRoot:process.env.ORBIT_VOICE_MODELS_ROOT??path.join(runtimeRoot??path.join(root,'.runtime'),'models'),
      securityHeaders,
    });
    return voiceAssets;
  }
  return {async handle(req,res,pathname){
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{...securityHeaders,Allow:'GET, HEAD'});res.end();return;}
    if(pathname.startsWith('/vendor/voice/')){
      try{return (await voice()).handle(req,res,pathname);}catch{res.writeHead(503,securityHeaders);res.end();return;}
    }
    const entry=files.get(pathname);
    if(!entry){res.writeHead(404,securityHeaders);res.end();return;}
    let fd;
    try{
      await noSymlinks(entry.file);
      fd=await open(entry.file,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await fd.stat();
      if(!info.isFile()||info.nlink!==1||info.size>40*1024*1024)throw Error('Invalid asset');
      res.writeHead(200,{...securityHeaders,'Content-Type':'font/woff2','Content-Length':info.size,'Cache-Control':entry.immutable?'public, max-age=31536000, immutable':'no-store'});
      if(req.method==='HEAD')res.end();else res.end(await fd.readFile());
    }catch(error){if(!res.headersSent){res.writeHead(error.code==='ENOENT'?404:503,securityHeaders);res.end();}else res.destroy();}
    finally{await fd?.close();}
  },async close(){await voiceAssets?.close?.();}};
}
