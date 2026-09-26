// Authoritative owner-facing result, provenance and reviewed patch contracts.
// All principal/scope fields on receipts are service-derived, never model arguments.
import Ajv from 'ajv';

const strict=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const resultUuid={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
export const resultHash={type:'string',pattern:'^[a-f0-9]{64}$'};
const scope={workspace_id:resultUuid,project_id:resultUuid};

export const RESULT_FRAME_VERSION=1;
export const RESULT_TEXT_MAX_BYTES=65536;
export const RESULT_FRAME_MAX_BYTES=73728;
export const RESULT_MAX_SUGGESTED_REFERENCES=16;
export const RESULT_PATCH_MAX_BYTES=1048576;
export const resultFrameSchema=strict({
  version:{const:RESULT_FRAME_VERSION},type:{const:'final_response'},
  text:{type:'string'},completed:{type:'boolean'},
});
export const resultAvailability=Object.freeze(['pending','available','explanation_unavailable']);
export const resultUnavailableReasons=Object.freeze([
  'missing','empty','malformed','oversized','duplicate','conflict','incomplete',
  'runtime_failed','fenced','persistence_failed','expired',
]);
const resultReference=strict({evidence_id:resultUuid});
const resolvedReference=strict({evidence_id:resultUuid,job_id:resultUuid,verdict:{enum:['pass','fail','inconclusive']}});
export const resultReceiptSchema=strict({
  version:{const:1},id:resultUuid,...scope,task_id:resultUuid,attempt_id:resultUuid,
  grant_id:resultUuid,run_id:resultUuid,project_generation:{type:'integer',minimum:1},
  candidate_id:resultUuid,candidate_generation:{type:'integer',minimum:1},candidate_hash:resultHash,
  recipient:strict({pane_id:resultUuid,profile_id:{type:'string',minLength:1,maxLength:200},session_id:{type:'string',minLength:1,maxLength:300}}),
  availability:{enum:resultAvailability},unavailable_reason:{anyOf:[{type:'null'},{enum:resultUnavailableReasons}]},
  text:{anyOf:[{type:'null'},{type:'string'}]},hermes_completed:{anyOf:[{type:'null'},{type:'boolean'}]},
  frame_hash:{anyOf:[{type:'null'},resultHash]},received_at:{anyOf:[{type:'null'},{type:'integer',minimum:0}]},
  retained_until:{type:'integer',minimum:0},
  model_suggested_references:{type:'array',items:resultReference,maxItems:RESULT_MAX_SUGGESTED_REFERENCES},
  resolved_references:{type:'array',items:resolvedReference,maxItems:RESULT_MAX_SUGGESTED_REFERENCES},
});

// Historical rows cannot establish origin merely from an old `actor` string.
const nativeInitiator=strict({kind:{const:'native_agent'},attempt_id:resultUuid,grant_id:resultUuid,run_id:resultUuid,tool_call_id:resultUuid});
const ownerInitiator=strict({kind:{const:'owner_action'}});
const unknown=strict({kind:{const:'legacy_unknown'}});
const ownerGrant=strict({kind:{const:'owner_grant'},grant_id:resultUuid,authority_generation:resultUuid});
const ownerApproval=strict({kind:{const:'owner_approval'},preview_id:resultUuid});
const serviceRecorder=strict({kind:{const:'comet_service'},component:{type:'string',minLength:1,maxLength:80},build_id:resultHash,verifier_id:{type:'string',minLength:1,maxLength:100},verifier_hash:resultHash});
export const workbenchProvenanceSchema=strict({
  version:{const:1},initiated_by:{oneOf:[nativeInitiator,ownerInitiator,unknown]},
  authorized_by:{oneOf:[ownerGrant,ownerApproval,unknown]},
  recorded_by:{oneOf:[serviceRecorder,unknown]},
});

// Owner-authenticated requests on existing /api/workbench/native. `cards_list`
// intentionally has workspace/pane binding, not a caller-selected project.
export const resultRequests=Object.freeze({
  result_get:strict({action:{const:'result_get'},...scope,result_id:resultUuid}),
  result_retry:strict({action:{const:'result_retry'},...scope,result_id:resultUuid,expected_digest:resultHash}),
  result_deliver:strict({action:{const:'result_deliver'},...scope,result_id:resultUuid,pane_id:resultUuid,profile_id:{type:'string',minLength:1,maxLength:200},session_id:{type:'string',minLength:1,maxLength:300},op_id:resultUuid}),
  cards_list:strict({action:{const:'cards_list'},workspace_id:resultUuid,pane_id:resultUuid,profile_id:{type:'string',minLength:1,maxLength:200},session_id:{type:'string',minLength:1,maxLength:300}}),
});

// Owner-authenticated requests on existing /api/workbench/workflow. No caller
// controls a filesystem path; artifact bytes are read only by scoped artifact ID.
export const patchRequests=Object.freeze({
  patch_preview:strict({action:{const:'patch_preview'},...scope,task_id:resultUuid,candidate_id:resultUuid,review_id:resultUuid}),
  patch_export:strict({action:{const:'patch_export'},...scope,task_id:resultUuid,candidate_id:resultUuid,review_id:resultUuid,preview_id:resultUuid,preview_digest:resultHash,op_id:resultUuid}),
  private_patch_get:strict({action:{const:'private_patch_get'},...scope,artifact_id:resultUuid}),
});
export const patchRequestSchema={oneOf:Object.values(patchRequests)};
const ajv=new Ajv({strict:true});
export const validateResultFrame=ajv.compile(resultFrameSchema);
export const validateResultReceipt=ajv.compile(resultReceiptSchema);
export const validateWorkbenchProvenance=ajv.compile(workbenchProvenanceSchema);
export const validateResultRequest=ajv.compile({oneOf:Object.values(resultRequests)});
export const validatePatchRequest=ajv.compile(patchRequestSchema);
