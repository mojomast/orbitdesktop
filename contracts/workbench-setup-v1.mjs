import Ajv from 'ajv';
import {nativeBudgetSchema} from './workbench-native-v1.mjs';
const uuid={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const text={type:'string',minLength:1,maxLength:4000,pattern:'\\S'};
const strict=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const brief={goal:text,title:{...text,maxLength:240},acceptance_statement:text,project_id:uuid,check_definition_id:{type:'string',minLength:1,maxLength:64}};
const base={workspace_id:uuid,pane_id:uuid,expected_binding_revision:{type:'integer',minimum:0}};
const owner=(action,fields={},optional=[])=>{const properties={action:{const:action},...base,...fields};return strict(properties,Object.keys(properties).filter(k=>!optional.includes(k)));};
export const setupRequests=Object.freeze({
  state:owner('state'),
  draft:owner('draft',{op_id:uuid,...brief},['title','acceptance_statement','check_definition_id']),
  preview:owner('preview',{draft_id:uuid,op_id:uuid}),
  prepare:owner('prepare',{preview_id:uuid,preview_digest:hash,op_id:uuid}),
  wait:owner('wait',{draft_id:uuid,op_id:uuid,deadline:{type:'integer',minimum:1},budget:nativeBudgetSchema}),
  wait_cancel:owner('wait_cancel',{intent_id:uuid,op_id:uuid}),
  launch_preview:owner('launch_preview',{draft_id:uuid,budget:nativeBudgetSchema}),
  launch:owner('launch',{draft_id:uuid,preview_id:uuid,preview_digest:hash,op_id:uuid}),
});
export const setupSchema={$schema:'http://json-schema.org/draft-07/schema#',oneOf:Object.values(setupRequests)};
export const setupProposalSchema=strict({workspace_id:uuid,op_id:uuid,...brief},['workspace_id','op_id','goal']);
const ajv=new Ajv({strict:true});
export const validateSetup=ajv.compile(setupSchema);
export const validateSetupProposal=ajv.compile(setupProposalSchema);
