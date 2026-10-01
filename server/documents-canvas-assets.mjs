// Pinned Excalidraw 0.18.1 adapter for Vite build AND dev. No dependency files
// are edited. It removes registrations from the real engine, not just its UI.
import {CANVAS_FONT_IDS,CANVAS_FONT_FAMILIES,CANVAS_FONT_POLICY_KEY} from '../contracts/documents-v1.mjs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export const CANVAS_FONT_SOURCE_FINGERPRINTS = Object.freeze({
  dev:'3cfe278cb537fde73b42bbd4697b392946517d3dc02d3f3cf8487d8476f63ba2',
  prod:'72b54e8e9b3c17c69f1dd5e40203bfaed62313bc611b86ecb8a1625a12562e51',
});
export function isPublishedCanvasFont(relative) {
  const pieces=relative.replaceAll('\\','/').split('/');
  return pieces.length===2&&CANVAS_FONT_FAMILIES.includes(pieces[0])&&/^[A-Za-z0-9_.-]+\.woff2$/.test(pieces[1]);
}
export function transformCanvasFontPolicy(code,id) {
  if(!/[\\/]node_modules[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/](?:dev|prod)[\\/][^?]+\.js(?:\?|$)/.test(id))return null;
  const removed=[];
  const transformed=code.replace(/\b[A-Za-z_$][\w$]*\(\s*"(Cascadia|Helvetica|Liberation Sans|Virgil)"\s*,\s*\.\.\.\s*[A-Za-z_$][\w$]*\s*\)/g,(_match,family)=>{removed.push(family);return 'void 0';});
  if(!removed.length)return null;
  const variant=id.replaceAll('\\','/').includes('/dist/prod/')?'prod':'dev';
  const fingerprint=createHash('sha256').update(code).digest('hex');
  if(fingerprint!==CANVAS_FONT_SOURCE_FINGERPRINTS[variant])throw Error('Pinned Excalidraw font source fingerprint changed; review before shipping.');
  if(removed.sort().join(',')!=='Cascadia,Helvetica,Liberation Sans,Virgil')throw Error('Pinned Excalidraw font registration adapter no longer matches; review before shipping.');
  for(const family of ['Comic Shanns','Excalifont','Lilita One','Nunito'])if(!code.includes(`"${family}",`))throw Error('Supported Excalidraw font registration missing.');
  let fallbacks=0;
  const local=transformed.replace(/`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`/g,()=>{fallbacks++;return 'new URL("/vendor/excalidraw-0.18.1/",globalThis.location.origin).href';});
  if(fallbacks!==1)throw Error('Pinned Excalidraw font fallback adapter no longer matches.');
  return {code:local+`\n;globalThis[Symbol.for(${JSON.stringify(CANVAS_FONT_POLICY_KEY)})]=Object.freeze({ids:Object.freeze(${JSON.stringify(CANVAS_FONT_IDS)}),source:${JSON.stringify(fingerprint)},fallback:"same-origin"});\n`,map:null};
}
export function canvasFontPolicyPlugin() {
  return {name:'orbit-reviewed-canvas-fonts',enforce:'pre',
    // Apply the same transform inside dependency prebundling: excluding the
    // engine instead exposes its transitive CommonJS imports directly to browsers.
    config(){return {optimizeDeps:{include:['@excalidraw/excalidraw','react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime'],esbuildOptions:{plugins:[{
      name:'orbit-reviewed-canvas-fonts-prebundle',setup(build){build.onLoad({filter:/[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/].*\.js$/},async args=>{
        const code=await readFile(args.path,'utf8');return {contents:transformCanvasFontPolicy(code,args.path)?.code??code,loader:'js'};
      });},
    }]}}};},
    transform:transformCanvasFontPolicy};
}
