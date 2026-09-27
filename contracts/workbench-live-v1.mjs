// Owner-only observability. No action in this contract admits execution.
import Ajv from 'ajv';
const uuid={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const strict=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const scope={workspace_id:uuid,project_id:uuid,attempt_id:uuid};
const cursor={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
export const LIVE_LIMITS=Object.freeze({page:200,retainedPerAttempt:2000,eventBytes:4096,tailBytes:16384,bufferBytes:262144,domRows:500});
export const liveReferenceSchema=strict({kind:{enum:['toolcall','candidate','job','evidence','result','review','artifact']},id:uuid,candidate_id:uuid,generation:{type:'integer',minimum:1},hash},['kind','id']);
export const workbenchLiveRequests=Object.freeze({
  stream:strict({action:{const:'stream'},...scope,after_sequence:cursor,limit:{type:'integer',minimum:1,maximum:LIVE_LIMITS.page}},['action','workspace_id','project_id']),
  page:strict({action:{const:'page'},...scope,after_sequence:cursor,limit:{type:'integer',minimum:1,maximum:LIVE_LIMITS.page}},['action','workspace_id','project_id']),
  detail:strict({action:{const:'detail'},...scope,reference:liveReferenceSchema},['action','workspace_id','project_id','reference']),
  tail:strict({action:{const:'tail'},...scope,job_id:uuid},['action','workspace_id','project_id','job_id']),
});
export const workbenchLiveSchema={$schema:'http://json-schema.org/draft-07/schema#',oneOf:Object.values(workbenchLiveRequests)};
export const liveItemSchema=strict({
  version:{const:1},id:{type:'string',minLength:1,maxLength:160},sequence:cursor,
  at:{type:['integer','null'],minimum:0},
  authority:{enum:['agent','observed','recorder','human']},category:{enum:['agent','tools','files','checks','evidence','warnings']},
  kind:{type:'string',minLength:1,maxLength:80},summary:{type:'string',maxLength:240},
  status:{enum:['ready','running','waiting','pending','completed','failed','denied','stopped','cancelled','unknown','info']},
  target:{type:'string',maxLength:512},duration_ms:{type:'number',minimum:0},
  fields:{type:'array',maxItems:12,items:strict({label:{type:'string',maxLength:80},value:{anyOf:[{type:'string',maxLength:240},{type:'number'}]}})},
  reference:liveReferenceSchema,
},['version','id','at','authority','category','kind','summary','status']);
const ajv=new Ajv({allErrors:false,strict:true});
export const validateWorkbenchLive=ajv.compile(workbenchLiveSchema);
export const validateLiveItem=ajv.compile(liveItemSchema);
