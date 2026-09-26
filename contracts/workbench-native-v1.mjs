// Owner requests and model arguments are separate contracts. No model argument
// can select an attempt, recipient, workspace, project, grant or authority.
import Ajv from 'ajv';
const strict=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const uuid={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const path={type:'string',minLength:1,maxLength:4096,pattern:'^[^\\u0000\\\\]+$'};
const base={workspace_id:uuid,project_id:uuid};
export const nativeBudgetSchema=strict({calls:{type:'integer',minimum:1,maximum:100},checks:{type:'integer',minimum:0,maximum:5},duration_ms:{type:'integer',minimum:1000,maximum:900000}});
export const nativeRequests=Object.freeze({
  list:strict({action:{const:'list'},...base}),
  preview:strict({action:{const:'preview'},...base,attempt_id:uuid,context_ids:{type:'array',items:uuid,maxItems:8,uniqueItems:true},budget:nativeBudgetSchema}),
  approve:strict({action:{const:'approve'},...base,preview_id:uuid,preview_digest:hash}),
  start:strict({action:{const:'start'},...base,grant_id:uuid}),
  status:strict({action:{const:'status'},...base,grant_id:uuid}),
  stop:strict({action:{const:'stop'},...base,grant_id:uuid}),
  acknowledge_unknown:strict({action:{const:'acknowledge_unknown'},...base,grant_id:uuid,expected_digest:hash,known_externally_terminated:{const:true}}),
});
export const nativeSchema=Object.freeze({$schema:'http://json-schema.org/draft-07/schema#',oneOf:Object.values(nativeRequests)});
const change={oneOf:[
  strict({op:{const:'create'},path,expected_hash:{type:'null'},content:{type:'string',maxLength:262144}}),
  strict({op:{const:'change'},path,expected_hash:hash,content:{type:'string',maxLength:262144}}),
  strict({op:{const:'delete'},path,expected_hash:hash}),
]};
export const nativeToolRequests=Object.freeze({
  inspect:strict({action:{const:'inspect'}}),
  read_context:strict({action:{const:'read_context'},context_id:uuid}),
  candidate_read:strict({action:{const:'candidate_read'},path}),
  candidate_patch:strict({action:{const:'candidate_patch'},expected_candidate_hash:hash,changes:{type:'array',minItems:1,maxItems:32,items:change}}),
  job_start:{...strict({action:{const:'job_start'},definition_id:{enum:['node-test','host-regression']}}),required:['action']},
  job_status:strict({action:{const:'job_status'},job_id:uuid}),
  evidence:strict({action:{const:'evidence'},job_id:uuid}),
});
export const nativeToolSchema={oneOf:Object.values(nativeToolRequests)};
const ajv=new Ajv({strict:true});
export const validateNative=ajv.compile(nativeSchema);
export const validateNativeTool=ajv.compile(nativeToolSchema);
export const HERMES_NATIVE_CONTRACT=Object.freeze({
  repository:'https://github.com/NousResearch/hermes-agent',
  commit:'d0288be5b3330d2442e3907185b8e9d0958297bb',
  package_version:'0.0.0',python:'3.14',
  source:['hermes_cli/plugins.py','model_tools.py','agent/conversation_loop.py','run_agent.py'],
  references:['https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/','https://github.com/NousResearch/hermes-agent/blob/d0288be5b3330d2442e3907185b8e9d0958297bb/hermes_cli/plugins.py'],
  transport:'OpenAI-compatible POST /v1/chat/completions; private per-attempt plugin HTTP over Unix socket',
  toolset:'orbit_workbench',tool:'orbit_workbench',
  isolation:'Dedicated process, private HOME/HERMES_HOME and inherited FD configuration. Trusted same-UID host execution, not an OS sandbox.',
});
