import Ajv from 'ajv';
import {COPILOT_LIMITS,COPILOT_ACTIONS} from '../contracts/browser-copilot-v1.mjs';
import {copilotError,digest} from './browser-copilot-driver.mjs';

const id={type:'string',pattern:'^[a-zA-Z0-9_-]{1,80}$'};
const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const timestamp={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const nullableId={anyOf:[id,{type:'null'}]};
const shape=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const observationSchema=shape({target_id:id,url_hash:hash,origin:{type:'string',pattern:'^https?://',maxLength:2048},display_url:{type:'string',pattern:'^https?://',maxLength:2048},title:{type:'string',maxLength:240},elements:{type:'array',maxItems:COPILOT_LIMITS.snapshotElements,items:shape({ref:id,role:{type:'string',maxLength:80},name:{type:'string',maxLength:240}})},text:{type:'string',maxLength:COPILOT_LIMITS.snapshotChars},truncated:{type:'boolean'},captured_at:timestamp});
const evidenceSummary=shape({evidence_id:hash,sha256:hash,bytes:{type:'integer',minimum:1,maximum:COPILOT_LIMITS.evidenceBytes},target_id:id,captured_at:timestamp});
const sessionSchema=shape({session_id:id,state:{enum:['starting','active','paused','closed','unknown']},revision:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},last_seen_at:timestamp,pending_op_key:nullableId});
const openResult=shape({session:sessionSchema,observation:observationSchema,evidence:evidenceSummary});
const executeResult=shape({session:sessionSchema,target_id:id,mode:{enum:['owner','manual']},operation_kind:{enum:COPILOT_ACTIONS},before:evidenceSummary,after:evidenceSummary,observation:observationSchema});
const reasons=['invalid_request','permission_denied','stale_resource','conflict','unsupported','unavailable','limit_exceeded','busy','driver_outcome_unknown','cancelled_browser_outcome_unknown','server_restarted_browser_outcome_unknown'];
const receiptBase={op_key:id,workspace_id:id,fingerprint:hash,created_at:timestamp,session_id:nullableId,target_id:nullableId,dispatched:{type:'boolean'}};
const baseRequired=Object.keys(receiptBase).filter(k=>k!=='dispatched');
const receiptSchema={oneOf:[
  shape({...receiptBase,status:{const:'pending'}},[...baseRequired,'status']),
  shape({...receiptBase,dispatched:{const:true},status:{const:'completed'},result:{oneOf:[openResult,executeResult]}},[...baseRequired,'status','dispatched','result']),
  shape({...receiptBase,status:{const:'unknown'},reason:{enum:reasons}},[...baseRequired,'status','reason']),
  shape({...receiptBase,dispatched:{const:false},status:{const:'refused'},reason:{enum:reasons}},[...baseRequired,'status','reason']),
]};
const evidenceSchema=shape({workspace_id:id,session_id:id,target_id:id,observation:observationSchema,sha256:hash,bytes:{type:'integer',minimum:1,maximum:COPILOT_LIMITS.evidenceBytes},captured_at:timestamp,evidence_id:hash});
const ajv=new Ajv({strict:true,allErrors:true});
const validateReceipt=ajv.compile(receiptSchema),validateEvidence=ajv.compile(evidenceSchema);
function verifyObservation(o){try{const origin=new URL(o.origin),display=new URL(o.display_url);if(origin.origin!==o.origin||display.origin!==o.origin||display.username||display.password||display.search||display.hash)throw Error();}catch{throw copilotError('unavailable');}}
export function verifyReceipt(record,filenameKey){
  if(!validateReceipt(record)||Buffer.byteLength(JSON.stringify(record))>256*1024||digest(record.workspace_id+'\0'+record.op_key)!==filenameKey)throw copilotError('unavailable');
  if(record.status==='completed'){
    const r=record.result;
    verifyObservation(r.observation);
    if(r.target_id){if(record.session_id!==r.session.session_id||record.target_id!==r.target_id||r.observation.target_id!==r.target_id||r.before.target_id!==r.target_id||r.after.target_id!==r.target_id)throw copilotError('unavailable');}
    else if(record.session_id!==null||record.target_id!==null||r.observation.target_id!==r.evidence.target_id)throw copilotError('unavailable');
  }
  return record;
}
export function verifyEvidence(record){
  if(!validateEvidence(record)||Buffer.byteLength(JSON.stringify(record))>128*1024||record.target_id!==record.observation.target_id)throw copilotError('unavailable');
  verifyObservation(record.observation);const {evidence_id,...meta}=record;if(digest(JSON.stringify(meta))!==evidence_id)throw copilotError('unavailable');return record;
}
export const safeReceiptReason=reason=>reasons.includes(reason)?reason:'driver_outcome_unknown';
