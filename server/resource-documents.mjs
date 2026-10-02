import {createHash} from 'node:crypto';
import {validateDocumentData} from '../contracts/documents-v1.mjs';
export const resourceDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Conversion produces editable reviewed Lexical text. Citations are durable plain
// text identities/offsets, not executable links or caller-supplied provenance.
export function briefData(text,citations,recipient) {
  const lines=[text,...citations.map(c=>`Source ${c.source_id} · sha256:${c.content_sha256} · characters ${c.char_start}–${c.char_end}`),`Created by Orbit delegated recipient ${recipient}`];
  const content=JSON.stringify({root:{type:'root',version:1,direction:null,format:'',indent:0,children:lines.map(text=>({type:'paragraph',version:1,direction:null,format:'',indent:0,children:[{type:'text',version:1,text,format:0,detail:0,mode:'normal',style:''}]}))}});
  const data={kind:'richtext',format:'lexical',content};validateDocumentData(data);return data;
}
