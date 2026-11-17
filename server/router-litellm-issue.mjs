// One explicit operator transaction against an already-provisioned local
// LiteLLM admin socket. Never used by the wizard, gateway, agents or workers.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { privateDirectory, privateText, checkPath } from './router-host.mjs';
import { validateOrbitConfig, resolveRoles } from './orbit-config.mjs';
import { liteLLMPolicy } from './router-litellm-policy.mjs';

export function liteLLMRolePlan(runtimeDir, role) {
  privateDirectory(runtimeDir);
  const config = validateOrbitConfig(JSON.parse(privateText(path.join(runtimeDir, 'orbit-config.json'), 1_048_576)));
  return liteLLMPolicy(runtimeDir, config.router, role, resolveRoles(config)[role]);
}

function postLocal(socketPath, key, body) {
  checkPath(socketPath);
  const st = fs.lstatSync(socketPath);
  if (!st.isSocket() || ![process.getuid(), 0].includes(st.uid)) throw Error('Invalid LiteLLM management socket.');
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/key/generate', method: 'POST', agent: false, signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }, res => {
      if (res.statusCode !== 200) { res.destroy(); reject(Error('Issuance refused.')); return; }
      const chunks = []; let length = 0;
      res.on('error', reject);
      res.on('data', chunk => {
        if ((length += chunk.length) > 65536) { res.destroy(); reject(Error('Unexpected response.')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(Error('Invalid response.')); } });
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}

export async function issueLiteLLMRole({ runtimeDir, manifestFile, role, confirmPolicy, post = postLocal }) {
  const plan = liteLLMRolePlan(runtimeDir, role);
  if (confirmPolicy !== plan.policySha256) throw Error('Explicit approval of this role policy is required.');
  if (!path.isAbsolute(manifestFile) || manifestFile.startsWith(runtimeDir + '/')) throw Error('Use a separate operator manifest.');
  const manifest = JSON.parse(privateText(manifestFile, 4096));
  if (!isDeepStrictEqual(Object.keys(manifest).sort(), ['baseUrl','masterKeyFile','runtimeDir','socketPath']) || manifest.runtimeDir !== runtimeDir || manifest.baseUrl !== plan.baseUrl) throw Error('Operator manifest does not match the selected service.');
  // The operator binds the local inference URL and this management transport
  // to the same reviewed deployment. No URLs, redirects or arbitrary argv.
  for (const p of [manifest.masterKeyFile, manifest.socketPath]) {
    if (!path.isAbsolute(p) || p.startsWith(runtimeDir + '/')) throw Error('Management paths must be outside the agent runtime.');
    privateDirectory(path.dirname(p));
  }
  const master = privateText(manifest.masterKeyFile, 16384).trim();
  if (!master || /\s/.test(master)) throw Error('Invalid management credential.');
  const keys = path.join(runtimeDir, 'keys');
  if (!fs.existsSync(keys)) fs.mkdirSync(keys, {mode:0o700});
  privateDirectory(keys);
  const output = path.join(keys, `router-vk-${role}.key`);
  if (fs.lstatSync(output,{throwIfNoEntry:false})) throw Error('Role key exists; issuance does not rotate or overwrite.');
  const receipt = path.join(keys, `.litellm-issue-${role}.json`);
  if (fs.lstatSync(receipt,{throwIfNoEntry:false})) throw Error('Reconcile the existing issuance receipt before creating another key.');
  const alias = `orbit-${role}-${randomUUID()}`;
  const marker = path.join(keys, `.litellm-issue-${role}.pending`);
  const fd = fs.openSync(marker, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({alias, policySha256: confirmPolicy})); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    const data = await post(manifest.socketPath, master, {...plan.request, key_alias:alias});
    // Validate the engine's effective scope before publishing any role file.
    if (!data || !isDeepStrictEqual(data.allowed_routes, ['llm_api_routes']) || !isDeepStrictEqual(data.models, plan.request.models) ||
        data.key_alias !== alias || data.max_budget !== plan.request.max_budget || data.budget_duration !== plan.request.budget_duration ||
        data.rpm_limit !== plan.request.rpm_limit || data.tpm_limit !== plan.request.tpm_limit ||
        typeof data.key !== 'string' || !/^sk-[A-Za-z0-9_-]{12,256}$/.test(data.key) || data.key === master ||
        liteLLMRolePlan(runtimeDir, role).policySha256 !== confirmPolicy) throw Error('Unverified issuance.');
    const staged = path.join(keys, `.issue-${randomUUID()}.tmp`);
    fs.writeFileSync(staged, data.key + '\n', {flag:'wx', mode:0o600});
    try { fs.linkSync(staged, output); } finally { fs.unlinkSync(staged); }
    fs.writeFileSync(receipt, JSON.stringify({ alias, policySha256:confirmPolicy, keySha256:createHash('sha256').update(data.key).digest('hex') }), {mode:0o600, flag:'wx'});
    fs.unlinkSync(marker);
    return {role, issued:true, alias};
  } catch {
    // The remote transaction may have committed. Keep the key-free alias for
    // manual revocation/reconciliation; never replay a lost response.
    throw Error('Unconfirmed LiteLLM issuance; reconcile the private pending alias before retrying.');
  }
}
