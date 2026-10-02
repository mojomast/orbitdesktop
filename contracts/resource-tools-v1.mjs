export const RESOURCE_LIMITS=Object.freeze({recipients:64,historyPage:32,sources:32,calls:100,readBytes:1048576,documentBytes:100000,documents:10,ttlMs:3600000});
const op={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
export const resourceToolSchema={type:'object',additionalProperties:false,required:['action'],properties:{
  action:{enum:['describe','search','read_source','create_document','receipt']},
  query:{type:'string',minLength:1,maxLength:500},source_id:{type:'string',pattern:'^[a-f0-9]{64}$'},
  offset:{type:'integer',minimum:0,maximum:100000},length:{type:'integer',minimum:1,maximum:16000},
  op_id:op,title:{type:'string',minLength:1,maxLength:160,pattern:'^[^\\u0000-\\u001f\\u007f]*$'},text:{type:'string',maxLength:100000},
  citations:{type:'array',maxItems:32,items:{type:'object',additionalProperties:false,required:['source_id','content_sha256','char_start','char_end'],properties:{source_id:{type:'string',pattern:'^[a-f0-9]{64}$'},content_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},char_start:{type:'integer',minimum:0},char_end:{type:'integer',minimum:1}}}},
}};
export const RESOURCE_ACTION_FIELDS={describe:[],search:['query'],read_source:['source_id','offset','length'],create_document:['op_id','title','text','citations'],receipt:['op_id']};
