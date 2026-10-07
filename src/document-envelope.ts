import {validateDocumentData,normalizeSceneContent} from '../contracts/documents-v1.mjs';

// Pure envelope parser with no DOM, CSS or workspace dependency, so the exact
// shipped logic is exercised by the Node suite as well as the browser fixture.
export type DocumentEnvelopeInspection=
  |{status:'ok';title:string;data:{kind:'richtext'|'scene';format:'lexical'|'excalidraw';content:string}}
  |{status:'absent'}
  |{status:'unavailable';code:string;reason:string};
const REFUSALS:Record<string,string>={
  invalid_request:'The envelope is not a supported document. Check that kind, format and content match each other.',
  limit_exceeded:'The envelope exceeds a document size or structure limit.',
  unsupported:'The canvas uses a retired font. Convert text to Excalifont (5), Nunito (6), Lilita One (7) or Comic Shanns (8).',
};
const FENCE=/```orbit-document[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
/** The last complete `orbit-document` fence, which may follow ordinary prose.
 * A whole-reply sole-key JSON object remains accepted. Nothing may follow the
 * final fence, so a reply cannot smuggle extra content past this boundary. */
function envelopeBody(text:string):{body:string}|{after:true}|null {
  const fences=[...text.matchAll(FENCE)];
  if(fences.length){const last=fences[fences.length-1];const at=(last.index??0)+last[0].length;return /^\s*$/.test(text.slice(at))?{body:last[1]}:{after:true};}
  return null;
}
/** Inspect a complete authenticated reply. `absent` means there is nothing to
 * deliver; `unavailable` means an envelope was present but could not be used,
 * and always carries a reason the owner can act on. */
export function inspectDocumentEnvelope(text:unknown):DocumentEnvelopeInspection {
  if(typeof text!=='string')return {status:'absent'};
  if(text.length>750000)return {status:'unavailable',code:'limit_exceeded',reason:REFUSALS.limit_exceeded};
  const fenced=envelopeBody(text);
  let body:string;
  if(fenced===null){if(!/^\s*\{\s*"document"\s*:/.test(text))return {status:'absent'};body=text;}
  else if('after' in fenced)return {status:'unavailable',code:'invalid_request',reason:'The orbit-document fence must be the last content in the reply. Nothing was created.'};
  else body=fenced.body;
  let value:unknown;
  try{value=JSON.parse(body);}catch{return {status:'unavailable',code:'invalid_request',reason:'The orbit-document block is not complete valid JSON. It may have been cut off; nothing was created.'};}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!(value as Record<string,unknown>).document)return {status:'unavailable',code:'invalid_request',reason:REFUSALS.invalid_request};
  const d=(value as {document:unknown}).document;
  if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['title','kind','format','content'].includes(k))||typeof (d as Record<string,unknown>).title!=='string'||!(d as Record<string,unknown>).title||!(d as Record<string,string>).title.trim()||(d as Record<string,string>).title.length>160)return {status:'unavailable',code:'invalid_request',reason:REFUSALS.invalid_request};
  const fields=d as Record<string,string>;
  let data:{kind:'richtext'|'scene';format:'lexical'|'excalidraw';content:string};
  try{
    // Scenes are normalized here too, so an agent-authored canvas with a full
    // Excalidraw appState is accepted rather than refused for view-only keys.
    if(fields.kind==='scene')data={kind:'scene',format:'excalidraw',content:normalizeSceneContent(fields.content??'')};
    else if(fields.kind==='richtext'&&fields.format==='lexical')data={kind:'richtext',format:'lexical',content:fields.content??''};
    else return {status:'unavailable',code:'invalid_request',reason:REFUSALS.invalid_request};
    validateDocumentData(data);
  }catch(error){
    const code=error instanceof Error&&typeof (error as unknown as {code?:unknown}).code==='string'?(error as unknown as {code:string}).code:'invalid_request';
    return {status:'unavailable',code,reason:REFUSALS[code]??REFUSALS.invalid_request};
  }
  return {status:'ok',title:fields.title,data};
}