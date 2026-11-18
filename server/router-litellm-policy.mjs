import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

export function liteLLMPolicy(runtimeDir, router, role, mapping) {
  const policy = router.virtualKeys.find(item => item.role === role);
  if (!router.enabled || router.mode !== 'builtin' || router.engine !== 'litellm' || router.bind !== 'loopback' || mapping?.provider !== 'router' || !policy) throw Error('Select Advanced LiteLLM and a routed role first.');
  // Empty models means unrestricted in LiteLLM. Never approximate a budget or
  // rate-limit window. A monthly window is not the same thing as thirty days.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(mapping.model) || !policy.allowedModels.some(m => m === '*' || m === mapping.model)) throw Error('One explicit permitted model is required.');
  if (policy.expiresAt !== null || !/^[1-9]\d*[mhd]$/.test(policy.budget.reset) || policy.rateLimit.reset !== '1m' ||
      ![policy.budget.usd, policy.rateLimit.requests, policy.rateLimit.tokens].every(n => Number.isFinite(n) && n > 0)) throw Error('Configure a positive budget with a minutes/hours/days window, positive per-minute limits, and no absolute expiry.');
  const request = { key_type: 'llm_api', models: [mapping.model], max_budget: policy.budget.usd, budget_duration: policy.budget.reset, rpm_limit: policy.rateLimit.requests, tpm_limit: policy.rateLimit.tokens };
  const plan = { runtimeDir, role, engineImage: router.image, baseUrl: `http://127.0.0.1:${router.port}/v1`, request };
  return { ...plan, policySha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
}

export function roleFileBound(runtimeDir, router, role, mapping, filesystem = fs) {
  const keys = path.join(runtimeDir, 'keys');
  const prefix = `.litellm-issue-${role}`;
  try {
    if (filesystem.existsSync(path.join(keys, `${prefix}.pending`))) return false;
    if (router.engine !== 'litellm') return !filesystem.existsSync(path.join(keys, `${prefix}.json`));
    const read = name => {
      const file = path.join(keys, name), st = filesystem.lstatSync(file);
      if (!st.isFile() || (st.mode & 0o077) || st.size > 16384) throw Error();
      return filesystem.readFileSync(file, 'utf8').trim();
    };
    const plan = liteLLMPolicy(runtimeDir, router, role, mapping);
    const receipt = JSON.parse(read(`${prefix}.json`));
    return receipt.policySha256 === plan.policySha256 && receipt.keySha256 === createHash('sha256').update(read(`router-vk-${role}.key`)).digest('hex');
  } catch { return false; }
}
