// Closed first Studio profile. No arbitrary source, filesystem path or model call.
const uuid={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const digest={type:'string',pattern:'^[a-f0-9]{64}$'};
export const STUDIO_PROFILE='focus-timer-v1';
export const studioSpec={type:'object',additionalProperties:false,required:['id','title','version','minutes','accent'],properties:{
  id:{type:'string',pattern:'^[a-z][a-z0-9-]{0,25}$'},title:{type:'string',minLength:1,maxLength:60,pattern:'^[^\\u0000-\\u001f\\u007f]+$'},
  version:{type:'string',pattern:'^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}$'},minutes:{type:'integer',minimum:1,maximum:180},accent:{type:'string',pattern:'^#[a-fA-F0-9]{6}$'},
}};
const shapes={list:{},draft:{operation_id:uuid,spec:studioSpec},get:{draft_id:uuid},check:{draft_id:uuid},preview:{draft_id:uuid,operation_id:uuid},install:{proposal_id:uuid,preview_digest:digest,artifact_digest:digest,operation_id:uuid,confirm:{const:true}},revoke:{draft_id:uuid,operation_id:uuid,base_revision:{type:'integer',minimum:1},confirm:{const:true}}};
export const studioSchema={oneOf:Object.entries(shapes).map(([action,fields])=>({type:'object',additionalProperties:false,required:['action','workspace_id',...Object.keys(fields)],properties:{action:{const:action},workspace_id:uuid,...fields}}))};
