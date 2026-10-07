// Selected-source research, private content verbs, and owner permission requests.
// One granted channel per conversation. Content verbs are narrow: create (text or
// scene), list, read and revision-bound revise of documents in the same workspace.
export const RESOURCE_LIMITS=Object.freeze({recipients:64,historyPage:32,sources:32,calls:100,readBytes:1048576,documentBytes:100000,documents:10,ttlMs:3600000,permissionRequests:8,documentList:64,documentReadBytes:200000});
const op={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const docId={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const citation={type:'object',additionalProperties:false,required:['source_id','content_sha256','char_start','char_end'],properties:{source_id:{type:'string',pattern:'^[a-f0-9]{64}$'},content_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},char_start:{type:'integer',minimum:0},char_end:{type:'integer',minimum:1}}};
export const RESOURCE_VERBS=Object.freeze(['search','read_source','create_document','list_documents','read_document','revise_document','request_permission']);
export const CONTENT_VERBS=Object.freeze(['list_documents','read_document','revise_document','request_permission']);
export const resourceToolSchema={type:'object',additionalProperties:false,required:['action'],properties:{
  action:{enum:['describe','search','read_source','create_document','list_documents','read_document','revise_document','request_permission','receipt']},
  query:{type:'string',minLength:1,maxLength:500},source_id:{type:'string',pattern:'^[a-f0-9]{64}$'},
  offset:{type:'integer',minimum:0,maximum:100000},length:{type:'integer',minimum:1,maximum:16000},
  op_id:op,title:{type:'string',minLength:1,maxLength:160,pattern:'^[^\\u0000-\\u001f\\u007f]*$'},text:{type:'string',maxLength:100000},
  citations:{type:'array',maxItems:32,items:citation},
  // Content creation: `text` builds a Lexical document, `scene` builds a canvas.
  // Exactly one of them is required, so kind can never be guessed.
  kind:{enum:['richtext','scene']},scene:{type:'string',minLength:2,maxLength:524288},
  document_id:docId,expected_revision:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER-1},
  // Permission request: what the agent needs and why, in owner-facing language.
  need:{enum:['create_canvas','read_document','revise_document','query_data','open_document','other']},
  reason:{type:'string',minLength:8,maxLength:500,pattern:'^[^\\u0000-\\u001f\\u007f]*$'},
},allOf:[
  // Exactly one body per document kind, enforced at the contract boundary so no
  // call path can construct an ambiguous or mismatched document.
  {if:{required:['kind'],properties:{kind:{const:'scene'}}},then:{required:['scene'],not:{required:['text']}}},
  {if:{required:['kind'],properties:{kind:{const:'richtext'}}},then:{required:['text'],not:{required:['scene']}}},
  // Content-bearing actions must always state their kind.
  {if:{required:['action'],properties:{action:{enum:['create_document','revise_document']}}},then:{required:['kind']}},
]};
export const RESOURCE_ACTION_FIELDS={
  describe:[],
  search:['query'],
  read_source:['source_id','offset','length'],
  create_document:['op_id','title','citations','kind','text','scene'],
  list_documents:['offset','length'],
  read_document:['document_id','offset','length'],
  revise_document:['op_id','document_id','expected_revision','title','kind','text','scene'],
  request_permission:['op_id','need','reason'],
  receipt:['op_id'],
};
export const RESOURCE_REQUIRED={
  search:['query'],
  read_source:['source_id'],
  create_document:['op_id','title','citations'],
  read_document:['document_id'],
  revise_document:['op_id','document_id','expected_revision','title'],
  request_permission:['op_id','need','reason'],
  receipt:['op_id'],
};
/** Owner decisions on a raised request. Approving widens verbs on an existing
 * grant only: it can never add sources, restore a revoked recipient or outlive it. */
export const PERMISSION_REQUEST_SCHEMA={type:'object',additionalProperties:false,required:['action','workspace_id','recipient_id','request_id'],properties:{
  action:{enum:['list_permission_requests','approve_permission','deny_permission']},
  workspace_id:{type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'},
  recipient_id:{type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'},
  request_id:op,
  expected_generation:{type:'integer',minimum:0},
}};