import { liteLLMRolePlan, issueLiteLLMRole } from '../server/router-litellm-issue.mjs';

const [action,runtimeDir,role,manifestFile,confirmPolicy,...extra] = process.argv.slice(2);
try {
  if (action === 'plan' && runtimeDir && role && !manifestFile) console.log(JSON.stringify(liteLLMRolePlan(runtimeDir, role), null, 2));
  else if (action === 'issue' && confirmPolicy && !extra.length) console.log(JSON.stringify(await issueLiteLLMRole({runtimeDir,role,manifestFile,confirmPolicy})));
  else throw Error();
} catch {
  console.error('LiteLLM role action refused. Check the plan, operator manifest and pending issuance record.');
  process.exitCode = 1;
}
