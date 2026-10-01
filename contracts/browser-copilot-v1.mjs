import Ajv from 'ajv';

export const COPILOT_LIMITS = Object.freeze({sessionsPerWorkspace:2, requestBytes:16384, snapshotElements:120, snapshotChars:20000, evidenceBytes:2*1024*1024, evidenceRetainedPerSession:40, actionTimeoutMs:10000, idleTimeoutMs:120000, receiptCount:2000});
export const COPILOT_ACTIONS = Object.freeze(['navigate','snapshot','click','fill','scroll']);
const id={type:'string',pattern:'^[a-zA-Z0-9_-]{1,80}$'};
const url={type:'string',minLength:1,maxLength:2048};
const revision={type:'integer',minimum:0};
const shape=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const copilotOperationSchema={oneOf:[
  shape({kind:{const:'navigate'},url}),shape({kind:{const:'snapshot'}}),
  shape({kind:{const:'click'},ref:id}),
  shape({kind:{const:'fill'},ref:id,text:{type:'string',maxLength:2000}}),
  shape({kind:{const:'scroll'},dy:{type:'integer',minimum:-2000,maximum:2000}}),
]};
const base={workspace_id:id};
const session={...base,session_id:id};
const target={...session,target_id:id};
const request=(action,fields={})=>shape({action:{const:action},...base,...fields});
export const copilotRequests={oneOf:[
  request('capability'),request('list'),request('open',{url,op_key:id}),
  request('targets',session),request('observe',target),
  request('preview',{...target,expected_revision:revision,operation:copilotOperationSchema,mode:{enum:['owner','manual']}}),
  request('execute',{...target,expected_revision:revision,proposal_id:id,op_key:id}),
  request('receipt',{op_key:id}),
  ...['pause','resume','cancel','close'].map(action=>request(action,session)),
  request('close_target',{...target,expected_revision:revision}),
  request('evidence',{...session,evidence_id:{type:'string',pattern:'^[a-f0-9]{64}$'}}),
  request('retention',{dry_run:{type:'boolean'}}),
]};
export const validateCopilotRequest=new Ajv({allErrors:true,strict:true}).compile(copilotRequests);
