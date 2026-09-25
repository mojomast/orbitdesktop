import Ajv from 'ajv';
import { contract } from '../contracts/workspace-v1.mjs';
// Code generation is only from the checked-in trusted schema. No remote schemas,
// coercion, defaults, removal of unknown properties, or model-selected code.
const ajv = new Ajv({strict:true,allErrors:false,coerceTypes:false,useDefaults:false,removeAdditional:false});
const validate = ajv.compile(contract.schema);
export const workspaceLimits = contract.limits;
export function validateWorkspaceRequest(body) {
  if (!validate(body)) {
    const error = Error(contract.errors.INVALID_OPERATION);
    error.category = 'INVALID_OPERATION';
    throw error;
  }
}
